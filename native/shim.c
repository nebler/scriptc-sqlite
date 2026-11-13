/* A thin C layer between scriptc's FFI and SQLite.
 *
 * scriptc's FFI passes numbers, 64-bit integers and pointers (as bigint),
 * and borrowed string and byte spans into C, but cannot return a string or
 * bytes. So every function that yields text or bytes takes a buffer that
 * TypeScript provides, copies at most its length, and returns the full
 * length: TypeScript asks again with a bigger buffer when the first was too
 * small ("length first, then copy").
 *
 * Handles (sqlite3 *, sqlite3_stmt *) cross as opaque pointers. Nothing here
 * keeps state between calls except thread-local values (the last prepare
 * code, the user-function dispatcher), so connections and statements may
 * live on any scriptc thread, one thread at a time each. */
#include <math.h>
#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include "sqlite3.h"

static int64_t copy_out(const void *src, size_t len, uint8_t *out, size_t cap) {
  if (len > 0 && len <= cap) memcpy(out, src, len);
  return (int64_t)len;
}

/* The FFI hands over a span (pointer, length) without a terminating NUL, and
 * an empty span may come with a null pointer. */
static const char *nonnull(const uint8_t *p) { return p ? (const char *)p : ""; }

/* The span as a NUL-terminated copy (sqlite3_free it), or NULL. */
static char *span_dup(const uint8_t *p, size_t n) {
  char *s = sqlite3_malloc64(n + 1);
  if (!s) return NULL;
  if (n) memcpy(s, p, n);
  s[n] = 0;
  return s;
}

/* ── connections ─────────────────────────────────────────────────────── */

/* Opens `path` (UTF-8 span). Returns the handle; on failure the handle may
 * still be non-null so that the error can be read, and must be closed. The
 * defaults follow Node's node:sqlite: foreign keys on, double-quoted string
 * literals off. */
void *sqx_open(const uint8_t *path, size_t path_len, int32_t read_only, int32_t foreign_keys,
               int32_t dqs, int32_t timeout_ms) {
  char name[4096];
  if (path_len >= sizeof name) return NULL;
  if (path_len) memcpy(name, path, path_len);
  name[path_len] = 0;
  sqlite3 *db = NULL;
  int flags = read_only ? SQLITE_OPEN_READONLY : (SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE);
  /* NOMUTEX: a connection never leaves the thread that opened it (a
   * scriptc worker shares no memory, and DatabaseSync cannot be posted),
   * so SQLite's per-connection mutex, taken on every step and column
   * read in the default serialized mode, only costs time: about a third
   * of a plain C scan. Different connections stay safe on different
   * threads (SQLite's multi-thread mode). */
  int rc = sqlite3_open_v2(name, &db, flags | SQLITE_OPEN_URI | SQLITE_OPEN_NOMUTEX, NULL);
  if (rc == SQLITE_OK && db) {
    sqlite3_db_config(db, SQLITE_DBCONFIG_ENABLE_FKEY, foreign_keys ? 1 : 0, (int *)NULL);
    sqlite3_db_config(db, SQLITE_DBCONFIG_DQS_DML, dqs ? 1 : 0, (int *)NULL);
    sqlite3_db_config(db, SQLITE_DBCONFIG_DQS_DDL, dqs ? 1 : 0, (int *)NULL);
    if (timeout_ms > 0) sqlite3_busy_timeout(db, timeout_ms);
  }
  return db;
}

/* The result code of the last open: SQLITE_NOMEM when no handle exists. */
int32_t sqx_open_failed(void *db) {
  if (!db) return SQLITE_NOMEM;
  return sqlite3_errcode((sqlite3 *)db);
}

int32_t sqx_close(void *db) { return sqlite3_close_v2((sqlite3 *)db); }

int32_t sqx_exec(void *db, const uint8_t *sql, size_t sql_len) {
  /* sqlite3_exec needs a NUL-terminated string; prepare in a loop instead,
   * which takes a length and keeps embedded text exactly as given. */
  const char *p = nonnull(sql);
  const char *end = p + sql_len;
  while (p < end) {
    sqlite3_stmt *stmt = NULL;
    const char *tail = NULL;
    int rc = sqlite3_prepare_v2((sqlite3 *)db, p, (int)(end - p), &stmt, &tail);
    if (rc != SQLITE_OK) return rc;
    if (stmt) {
      do rc = sqlite3_step(stmt);
      while (rc == SQLITE_ROW);
      if (rc != SQLITE_DONE) {
        sqlite3_finalize(stmt);
        return rc;
      }
      sqlite3_finalize(stmt);
    }
    if (!tail || tail <= p) break;
    p = tail;
  }
  return SQLITE_OK;
}

int32_t sqx_errcode(void *db) { return sqlite3_extended_errcode((sqlite3 *)db); }

int64_t sqx_errmsg(void *db, uint8_t *out, size_t cap) {
  const char *m = sqlite3_errmsg((sqlite3 *)db);
  return copy_out(m, strlen(m), out, cap);
}

int64_t sqx_errstr(int32_t code, uint8_t *out, size_t cap) {
  const char *m = sqlite3_errstr(code);
  return copy_out(m, strlen(m), out, cap);
}

int32_t sqx_in_transaction(void *db) { return !sqlite3_get_autocommit((sqlite3 *)db); }

int64_t sqx_changes(void *db) { return sqlite3_changes64((sqlite3 *)db); }

int64_t sqx_last_insert_rowid(void *db) { return sqlite3_last_insert_rowid((sqlite3 *)db); }

/* The same two as doubles, for the default (non-bigint) results: Number()
 * of the int64 rounds the same way, without a bigint per run(). */
double sqx_changes_f64(void *db) { return (double)sqlite3_changes64((sqlite3 *)db); }
double sqx_last_insert_rowid_f64(void *db) { return (double)sqlite3_last_insert_rowid((sqlite3 *)db); }

/* ── statements ──────────────────────────────────────────────────────── */

/* Compiles the first statement of `sql`. Returns NULL on error (read it with
 * sqx_errcode/sqx_errmsg) and also for text that holds no statement, which
 * sqx_prepare_rc tells apart. */
static _Thread_local int last_prepare_rc;
void *sqx_prepare(void *db, const uint8_t *sql, size_t sql_len) {
  sqlite3_stmt *stmt = NULL;
  last_prepare_rc = sqlite3_prepare_v2((sqlite3 *)db, nonnull(sql), (int)sql_len, &stmt, NULL);
  return stmt;
}
int32_t sqx_prepare_rc(void) { return last_prepare_rc; }

int32_t sqx_finalize(void *stmt) { return sqlite3_finalize((sqlite3_stmt *)stmt); }

int32_t sqx_reset(void *stmt) {
  int rc = sqlite3_reset((sqlite3_stmt *)stmt);
  sqlite3_clear_bindings((sqlite3_stmt *)stmt);
  return rc;
}

/* SQLITE_ROW (100), SQLITE_DONE (101) or an error code. */
int32_t sqx_step(void *stmt) { return sqlite3_step((sqlite3_stmt *)stmt); }

/* StatementSync.runMany: steps a bound statement to the end (ignoring any
 * rows it returns), resets it and clears its bindings for the next row, in
 * one call. Returns the step's result code (SQLITE_DONE when it ran); the
 * row's changes add up in a thread-local that sqx_take_changes returns. */
static _Thread_local double many_changes;

int32_t sqx_step_reset(void *stmt) {
  sqlite3_stmt *s = (sqlite3_stmt *)stmt;
  int rc = sqlite3_step(s);
  while (rc == SQLITE_ROW) rc = sqlite3_step(s);
  if (rc == SQLITE_DONE) many_changes += (double)sqlite3_changes64(sqlite3_db_handle(s));
  sqlite3_reset(s);
  sqlite3_clear_bindings(s);
  return rc;
}

void sqx_clear_bindings(void *stmt) { sqlite3_clear_bindings((sqlite3_stmt *)stmt); }

double sqx_take_changes(void) {
  double n = many_changes;
  many_changes = 0;
  return n;
}

int64_t sqx_sql(void *stmt, uint8_t *out, size_t cap) {
  const char *s = sqlite3_sql((sqlite3_stmt *)stmt);
  return s ? copy_out(s, strlen(s), out, cap) : 0;
}

/* The statement's text with its current bindings written in. SQLite makes a
 * fresh copy each time, so a second call with a bigger buffer gets the same
 * text as long as the bindings did not change in between. */
int64_t sqx_expanded_sql(void *stmt, uint8_t *out, size_t cap) {
  char *s = sqlite3_expanded_sql((sqlite3_stmt *)stmt);
  if (!s) return -1;
  int64_t n = copy_out(s, strlen(s), out, cap);
  sqlite3_free(s);
  return n;
}

/* ── parameters ──────────────────────────────────────────────────────── */

int32_t sqx_param_count(void *stmt) { return sqlite3_bind_parameter_count((sqlite3_stmt *)stmt); }

/* The parameter's name with its prefix ($, : or @), or -1 for "?" / "?NNN". */
int64_t sqx_param_name(void *stmt, int32_t i, uint8_t *out, size_t cap) {
  const char *n = sqlite3_bind_parameter_name((sqlite3_stmt *)stmt, i);
  if (!n) return -1;
  return copy_out(n, strlen(n), out, cap);
}

int32_t sqx_bind_null(void *stmt, int32_t i) { return sqlite3_bind_null((sqlite3_stmt *)stmt, i); }

int32_t sqx_bind_double(void *stmt, int32_t i, double v) {
  return sqlite3_bind_double((sqlite3_stmt *)stmt, i, v);
}

int32_t sqx_bind_int64(void *stmt, int32_t i, int64_t v) {
  return sqlite3_bind_int64((sqlite3_stmt *)stmt, i, v);
}

/* An empty span may arrive as a null pointer; SQLite would bind that as
 * NULL, so empty text and blobs are bound explicitly as empty values. */
int32_t sqx_bind_text(void *stmt, int32_t i, const uint8_t *p, size_t n) {
  return sqlite3_bind_text64((sqlite3_stmt *)stmt, i, nonnull(p), (sqlite3_uint64)n, SQLITE_TRANSIENT,
                             SQLITE_UTF8);
}

int32_t sqx_bind_blob(void *stmt, int32_t i, const uint8_t *p, size_t n) {
  if (n == 0) return sqlite3_bind_zeroblob((sqlite3_stmt *)stmt, i, 0);
  return sqlite3_bind_blob64((sqlite3_stmt *)stmt, i, p, (sqlite3_uint64)n, SQLITE_TRANSIENT);
}

/* ── columns ─────────────────────────────────────────────────────────── */

int32_t sqx_column_count(void *stmt) { return sqlite3_column_count((sqlite3_stmt *)stmt); }

int64_t sqx_column_name(void *stmt, int32_t i, uint8_t *out, size_t cap) {
  const char *n = sqlite3_column_name((sqlite3_stmt *)stmt, i);
  return n ? copy_out(n, strlen(n), out, cap) : 0;
}

/* Where a result column comes from: which = 0 database, 1 table, 2 column
 * in that table, 3 declared type. -1 when SQLite has no answer (an
 * expression, a literal). Needs SQLITE_ENABLE_COLUMN_METADATA. */
int64_t sqx_column_origin(void *stmt, int32_t i, int32_t which, uint8_t *out, size_t cap) {
  sqlite3_stmt *s = (sqlite3_stmt *)stmt;
  const char *v = which == 0   ? sqlite3_column_database_name(s, i)
                  : which == 1 ? sqlite3_column_table_name(s, i)
                  : which == 2 ? sqlite3_column_origin_name(s, i)
                               : sqlite3_column_decltype(s, i);
  if (!v) return -1;
  return copy_out(v, strlen(v), out, cap);
}

/* SQLITE_INTEGER 1, FLOAT 2, TEXT 3, BLOB 4, NULL 5. */
int32_t sqx_column_type(void *stmt, int32_t i) { return sqlite3_column_type((sqlite3_stmt *)stmt, i); }

int64_t sqx_column_int64(void *stmt, int32_t i) { return sqlite3_column_int64((sqlite3_stmt *)stmt, i); }

/* Typed reads (StatementSync.map/forEach): one call per value, which also
 * checks the column's type. A number column (INTEGER within ±(2^53 - 1),
 * or REAL) as a double; NaN for anything else, after which TypeScript
 * asks for the type to say what went wrong (SQLite never stores a NaN:
 * it becomes NULL). */
double sqx_column_number(void *stmt, int32_t i) {
  sqlite3_stmt *s = (sqlite3_stmt *)stmt;
  int type = sqlite3_column_type(s, i);
  if (type == SQLITE_FLOAT) return sqlite3_column_double(s, i);
  if (type != SQLITE_INTEGER) return NAN;
  int64_t v = sqlite3_column_int64(s, i);
  const int64_t max = 9007199254740991LL;
  return v > max || v < -max ? NAN : (double)v;
}

/* A TEXT column copied as for sqx_column_text; -1 if the column is not
 * TEXT (nothing converted). Likewise for BLOB. */
double sqx_column_text_typed(void *stmt, int32_t i, uint8_t *out, size_t cap) {
  sqlite3_stmt *s = (sqlite3_stmt *)stmt;
  if (sqlite3_column_type(s, i) != SQLITE_TEXT) return -1;
  const unsigned char *t = sqlite3_column_text(s, i);
  size_t n = (size_t)sqlite3_column_bytes(s, i);
  return t ? (double)copy_out(t, n, out, cap) : 0;
}

double sqx_column_blob_typed(void *stmt, int32_t i, uint8_t *out, size_t cap) {
  sqlite3_stmt *s = (sqlite3_stmt *)stmt;
  if (sqlite3_column_type(s, i) != SQLITE_BLOB) return -1;
  const void *b = sqlite3_column_blob(s, i);
  size_t n = (size_t)sqlite3_column_bytes(s, i);
  return b ? (double)copy_out(b, n, out, cap) : 0;
}

/* An integer column as a double within ±(2^53 - 1), NaN outside (as
 * sqx_value_safe_int): no bigint to allocate per value. */
double sqx_column_safe_int(void *stmt, int32_t i) {
  int64_t v = sqlite3_column_int64((sqlite3_stmt *)stmt, i);
  const int64_t max = 9007199254740991LL;
  return v > max || v < -max ? NAN : (double)v;
}

double sqx_column_double(void *stmt, int32_t i) { return sqlite3_column_double((sqlite3_stmt *)stmt, i); }

/* Text and blob values: the full length is returned, at most `cap` bytes are
 * copied. The value stays valid until the next step, reset or finalize, so
 * a second call with a bigger buffer sees the same bytes. Text is read as
 * UTF-8 first, then measured, as SQLite's documentation requires. */
double sqx_column_text(void *stmt, int32_t i, uint8_t *out, size_t cap) {
  const unsigned char *t = sqlite3_column_text((sqlite3_stmt *)stmt, i);
  size_t n = (size_t)sqlite3_column_bytes((sqlite3_stmt *)stmt, i);
  return t ? copy_out(t, n, out, cap) : 0;
}

double sqx_column_blob(void *stmt, int32_t i, uint8_t *out, size_t cap) {
  const void *b = sqlite3_column_blob((sqlite3_stmt *)stmt, i);
  size_t n = (size_t)sqlite3_column_bytes((sqlite3_stmt *)stmt, i);
  return b ? copy_out(b, n, out, cap) : 0;
}

/* ── serialize, deserialize, location, backup ────────────────────────── */

/* sqlite3_serialize makes a fresh copy each time, so this serializes once
 * and keeps the copy (thread-local) until sqx_serialized_take copies it
 * out and frees it. Returns the size, or -1 when SQLite failed (read the
 * error from the connection). `name` is the schema ("main"). */
static _Thread_local unsigned char *serialized;
static _Thread_local sqlite3_int64 serialized_size;

int64_t sqx_serialize(void *db, const uint8_t *name, size_t name_len) {
  char *schema = span_dup(name, name_len);
  if (!schema) return -1;
  if (serialized) sqlite3_free(serialized);
  serialized_size = 0;
  serialized = sqlite3_serialize((sqlite3 *)db, schema, &serialized_size, 0);
  sqlite3_free(schema);
  if (!serialized) return serialized_size > 0 ? -1 : 0;
  return (int64_t)serialized_size;
}

void sqx_serialized_take(uint8_t *out, size_t cap) {
  if (serialized && (size_t)serialized_size <= cap) memcpy(out, serialized, (size_t)serialized_size);
  sqlite3_free(serialized);
  serialized = NULL;
  serialized_size = 0;
}

/* Replaces schema `name` with a copy of the bytes, which SQLite owns and
 * may grow (as Node does). */
int32_t sqx_deserialize(void *db, const uint8_t *name, size_t name_len, const uint8_t *p, size_t n) {
  char *schema = span_dup(name, name_len);
  if (!schema) return SQLITE_NOMEM;
  unsigned char *copy = sqlite3_malloc64(n);
  if (!copy) {
    sqlite3_free(schema);
    return SQLITE_NOMEM;
  }
  memcpy(copy, p, n);
  int rc = sqlite3_deserialize((sqlite3 *)db, schema, copy, (sqlite3_int64)n, (sqlite3_int64)n,
                               SQLITE_DESERIALIZE_FREEONCLOSE | SQLITE_DESERIALIZE_RESIZEABLE);
  sqlite3_free(schema);
  return rc;
}

/* The file behind schema `name`; -1 for none (in-memory, temporary). */
int64_t sqx_db_filename(void *db, const uint8_t *name, size_t name_len, uint8_t *out, size_t cap) {
  char *schema = span_dup(name, name_len);
  if (!schema) return -1;
  const char *f = sqlite3_db_filename((sqlite3 *)db, schema);
  sqlite3_free(schema);
  if (!f || !f[0]) return -1;
  return copy_out(f, strlen(f), out, cap);
}

/* An online backup into a new connection to `path`. The handle holds both;
 * sqx_backup_finish closes them. Errors are the destination's, as in
 * Node. */
struct sqx_backup {
  sqlite3 *dest;
  sqlite3_backup *backup;
};

void *sqx_backup_open(void *src, const uint8_t *path, size_t path_len, const uint8_t *src_name, size_t src_len,
                      const uint8_t *dest_name, size_t dest_len) {
  struct sqx_backup *b = sqlite3_malloc(sizeof *b);
  if (!b) return NULL;
  b->dest = NULL;
  b->backup = NULL;
  char *file = span_dup(path, path_len), *from = span_dup(src_name, src_len), *to = span_dup(dest_name, dest_len);
  if (file && from && to) {
    if (sqlite3_open_v2(file, &b->dest, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_URI | SQLITE_OPEN_NOMUTEX,
                        NULL) ==
        SQLITE_OK)
      b->backup = sqlite3_backup_init(b->dest, to, (sqlite3 *)src, from);
  }
  sqlite3_free(file);
  sqlite3_free(from);
  sqlite3_free(to);
  return b;
}

/* 1 when the backup started; else read the error with sqx_backup_errcode
 * and sqx_backup_errmsg. */
int32_t sqx_backup_ok(void *p) { return ((struct sqx_backup *)p)->backup != NULL; }

int32_t sqx_backup_step(void *p, int32_t pages) { return sqlite3_backup_step(((struct sqx_backup *)p)->backup, pages); }
int32_t sqx_backup_total(void *p) { return sqlite3_backup_pagecount(((struct sqx_backup *)p)->backup); }
int32_t sqx_backup_remaining(void *p) { return sqlite3_backup_remaining(((struct sqx_backup *)p)->backup); }

int32_t sqx_backup_errcode(void *p) {
  struct sqx_backup *b = p;
  return b->dest ? sqlite3_extended_errcode(b->dest) : SQLITE_NOMEM;
}

int64_t sqx_backup_errmsg(void *p, uint8_t *out, size_t cap) {
  struct sqx_backup *b = p;
  const char *m = b->dest ? sqlite3_errmsg(b->dest) : sqlite3_errstr(SQLITE_NOMEM);
  return copy_out(m, strlen(m), out, cap);
}

void sqx_backup_finish(void *p) {
  struct sqx_backup *b = p;
  if (b->backup) sqlite3_backup_finish(b->backup);
  if (b->dest) sqlite3_close_v2(b->dest);
  sqlite3_free(b);
}

/* ── packed rows ─────────────────────────────────────────────────────── */

/* A whole row in one call, instead of one or two calls per value. Each
 * column is a type byte (SQLITE_INTEGER 1, FLOAT 2, TEXT 3, BLOB 4, NULL 5)
 * followed by 8 bytes for an integer (int64) or a float (IEEE double), or
 * 4 bytes of length and the bytes for text and blobs. Numbers are written
 * little-endian whatever the machine.
 *
 * Returns the packed length (copied only if it fits in cap); the caller
 * asks again with sqx_row and a bigger buffer when it did not fit. */
static void put64(uint8_t *p, uint64_t v) {
  for (int i = 0; i < 8; i++) p[i] = (uint8_t)(v >> (8 * i));
}

double sqx_row(void *stmt, uint8_t *out, size_t cap) {
  sqlite3_stmt *s = (sqlite3_stmt *)stmt;
  int count = sqlite3_column_count(s);
  size_t need = 0;
  for (int i = 0; i < count; i++) {
    int type = sqlite3_column_type(s, i);
    if (type == SQLITE_INTEGER || type == SQLITE_FLOAT) need += 9;
    else if (type == SQLITE_TEXT) {
      sqlite3_column_text(s, i); /* converts to UTF-8 first, then measure */
      need += 5 + (size_t)sqlite3_column_bytes(s, i);
    } else if (type == SQLITE_BLOB) need += 5 + (size_t)sqlite3_column_bytes(s, i);
    else need += 1;
  }
  if (need > cap) return (double)need;
  uint8_t *p = out;
  for (int i = 0; i < count; i++) {
    int type = sqlite3_column_type(s, i);
    *p++ = (uint8_t)type;
    if (type == SQLITE_INTEGER) {
      put64(p, (uint64_t)sqlite3_column_int64(s, i));
      p += 8;
    } else if (type == SQLITE_FLOAT) {
      double d = sqlite3_column_double(s, i);
      uint64_t bits;
      memcpy(&bits, &d, 8);
      put64(p, bits);
      p += 8;
    } else if (type == SQLITE_TEXT || type == SQLITE_BLOB) {
      const void *v = type == SQLITE_TEXT ? (const void *)sqlite3_column_text(s, i) : sqlite3_column_blob(s, i);
      uint32_t n = (uint32_t)sqlite3_column_bytes(s, i);
      for (int k = 0; k < 4; k++) p[k] = (uint8_t)(n >> (8 * k));
      p += 4;
      if (n > 0 && v) memcpy(p, v, n);
      p += n;
    }
  }
  return (double)need;
}

/* An environment variable's value (copied as usual), or -1 when unset. */
int64_t sqx_getenv(const uint8_t *name, size_t name_len, uint8_t *out, size_t cap) {
  char *n = span_dup(name, name_len);
  if (!n) return -1;
  const char *v = getenv(n);
  sqlite3_free(n);
  return v ? copy_out(v, strlen(v), out, cap) : -1;
}

/* 1 when SCRIPTC_SQLITE_ROW_READS=packed asks for packed row reads
 * (sqx_step_row) instead of per-value reads. Read here, not through
 * process.env: in scriptc 0.4.12, touching process.env costs about
 * 10 MiB of memory per thread. */
int32_t sqx_packed_mode(void) {
  const char *v = getenv("SCRIPTC_SQLITE_ROW_READS");
  return v && strcmp(v, "packed") == 0;
}

/* Steps; on a row, packs it as sqx_row does and returns its length (>= 0).
 * Otherwise returns -1 - rc: -102 for SQLITE_DONE, -2 for SQLITE_ERROR. */
double sqx_step_row(void *stmt, uint8_t *out, size_t cap) {
  int rc = sqlite3_step((sqlite3_stmt *)stmt);
  if (rc != SQLITE_ROW) return -1.0 - rc;
  return sqx_row(stmt, out, cap);
}

/* ── user-defined functions ──────────────────────────────────────────── */

/* SQLite keeps a function's callbacks long after the call that registers
 * it, so TypeScript registers one retained dispatcher per thread (a scriptc
 * FFI callback with a context pointer) and every function SQLite calls goes
 * through it: `op` says which callback this is, `id` which function (the
 * user-data pointer given at registration), and TypeScript reads the
 * arguments and sets the result with the sqx_value_* and sqx_result_*
 * functions below. SQLite calls a function on the thread that steps the
 * statement, so the dispatcher is thread-local, like everything else here.
 *
 * The dispatcher returns 1 when it set a result. Anything else means a
 * TypeScript exception is waiting on that side; the function then fails
 * with an empty error message, which TypeScript replaces with that
 * exception (as Node does). A dispatcher that throws is seen here as 0. */
enum { SQX_FUNC = 0, SQX_STEP = 1, SQX_INVERSE = 2, SQX_VALUE = 3, SQX_FINAL = 4, SQX_DESTROY = 5 };
/* The callback gets plain numbers only: a pointer reaches TypeScript as a
 * bigint, which scriptc allocates, and these run once per row. The call's
 * context and arguments stay here, in thread-locals that the sqx_value_*,
 * sqx_result_* and sqx_agg_* functions use. They are saved and restored
 * around each call, so a function that runs a query that calls another
 * function finds its own again afterwards. `id` is a double so that ids
 * and group slots never wrap (exact up to 2^53). */
typedef int32_t (*sqx_dispatch_fn)(int32_t op, double id, int32_t argc, void *user);
static _Thread_local sqx_dispatch_fn dispatch_fn;
static _Thread_local void *dispatch_user;
static _Thread_local sqlite3_context *cur_ctx;
static _Thread_local sqlite3_value **cur_argv;

void sqx_set_dispatch(sqx_dispatch_fn fn, void *user) {
  dispatch_fn = fn;
  dispatch_user = user;
}

static void call_dispatch(int op, sqlite3_context *ctx, int argc, sqlite3_value **argv) {
  int64_t id = (int64_t)(intptr_t)sqlite3_user_data(ctx);
  if (!dispatch_fn) {
    sqlite3_result_error(ctx, "user-defined function called on a thread that did not define it", -1);
    return;
  }
  sqlite3_context *saved_ctx = cur_ctx;
  sqlite3_value **saved_argv = cur_argv;
  cur_ctx = ctx;
  cur_argv = argv;
  int32_t ok = dispatch_fn(op, (double)id, argc, dispatch_user);
  cur_ctx = saved_ctx;
  cur_argv = saved_argv;
  if (ok != 1) sqlite3_result_error(ctx, "", 0);
}

static void x_func(sqlite3_context *ctx, int argc, sqlite3_value **argv) { call_dispatch(SQX_FUNC, ctx, argc, argv); }
static void x_step(sqlite3_context *ctx, int argc, sqlite3_value **argv) { call_dispatch(SQX_STEP, ctx, argc, argv); }
static void x_inverse(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
  call_dispatch(SQX_INVERSE, ctx, argc, argv);
}
static void x_value(sqlite3_context *ctx) { call_dispatch(SQX_VALUE, ctx, 0, NULL); }
static void x_final(sqlite3_context *ctx) { call_dispatch(SQX_FINAL, ctx, 0, NULL); }

/* SQLite drops a function when it is replaced or the connection closes;
 * TypeScript then forgets it. Only ever on the thread that uses it. */
static void x_destroy(void *p) {
  if (dispatch_fn) dispatch_fn(SQX_DESTROY, (double)(int64_t)(intptr_t)p, 0, dispatch_user);
}

/* `name` is a UTF-8 span. `flags` holds SQLITE_DETERMINISTIC and
 * SQLITE_DIRECTONLY as TypeScript computed them; SQLITE_UTF8 is added here.
 * As SQLite does when registering fails, x_destroy runs if the name cannot
 * be copied, so TypeScript forgets the function either way. */
int32_t sqx_create_function(void *db, const uint8_t *name, size_t name_len, int32_t argc, int32_t flags, double id) {
  void *user = (void *)(intptr_t)(int64_t)id;
  char *fname = span_dup(name, name_len);
  if (!fname) {
    x_destroy(user);
    return SQLITE_NOMEM;
  }
  int rc = sqlite3_create_function_v2((sqlite3 *)db, fname, argc, SQLITE_UTF8 | flags, user, x_func, NULL, NULL,
                                      x_destroy);
  sqlite3_free(fname);
  return rc;
}

/* `window` (an aggregate with an inverse) registers xValue and xInverse. */
int32_t sqx_create_aggregate(void *db, const uint8_t *name, size_t name_len, int32_t argc, int32_t flags, double id,
                             int32_t window) {
  void *user = (void *)(intptr_t)(int64_t)id;
  char *fname = span_dup(name, name_len);
  if (!fname) {
    x_destroy(user);
    return SQLITE_NOMEM;
  }
  int rc = sqlite3_create_window_function((sqlite3 *)db, fname, argc, SQLITE_UTF8 | flags, user, x_step, x_final,
                                          window ? x_value : NULL, window ? x_inverse : NULL, x_destroy);
  sqlite3_free(fname);
  return rc;
}

/* The current aggregate group's slot: a number TypeScript chooses to find
 * the group's state, kept in SQLite's aggregate context. 0 until set; -1
 * when SQLite could not allocate the context. */
double sqx_agg_slot(void) {
  int64_t *slot = sqlite3_aggregate_context(cur_ctx, (int)sizeof(int64_t));
  return slot ? (double)*slot : -1;
}

void sqx_agg_set_slot(double value) {
  int64_t *slot = sqlite3_aggregate_context(cur_ctx, (int)sizeof(int64_t));
  if (slot) *slot = (int64_t)value;
}

/* The current call's arguments; i is checked by TypeScript against argc.
 * Text and blobs as for columns: full length returned, at most cap bytes
 * copied; the value stays put while the function runs. */
static sqlite3_value *arg(int32_t i) { return cur_argv[i]; }

int32_t sqx_value_type(int32_t i) { return sqlite3_value_type(arg(i)); }
int64_t sqx_value_int64(int32_t i) { return sqlite3_value_int64(arg(i)); }
double sqx_value_double(int32_t i) { return sqlite3_value_double(arg(i)); }

/* A number argument (INTEGER within ±(2^53 - 1), or REAL) as a double, in
 * one call; NaN for anything else (SQLite never stores a NaN). For
 * db.numberFunction. */
double sqx_value_number(int32_t i) {
  sqlite3_value *v = arg(i);
  int type = sqlite3_value_type(v);
  if (type == SQLITE_FLOAT) return sqlite3_value_double(v);
  if (type != SQLITE_INTEGER) return NAN;
  int64_t n = sqlite3_value_int64(v);
  const int64_t max = 9007199254740991LL;
  return n > max || n < -max ? NAN : (double)n;
}

/* An integer argument as a double when it is within ±(2^53 - 1), where
 * the two agree exactly; NaN otherwise (TypeScript then reads it as a
 * bigint to report it). Saves allocating a bigint per argument. */
double sqx_value_safe_int(int32_t i) {
  int64_t v = sqlite3_value_int64(arg(i));
  const int64_t max = 9007199254740991LL;
  return v > max || v < -max ? NAN : (double)v;
}

double sqx_value_text(int32_t i, uint8_t *out, size_t cap) {
  const unsigned char *t = sqlite3_value_text(arg(i));
  size_t n = (size_t)sqlite3_value_bytes(arg(i));
  return t ? copy_out(t, n, out, cap) : 0;
}

double sqx_value_blob(int32_t i, uint8_t *out, size_t cap) {
  const void *b = sqlite3_value_blob(arg(i));
  size_t n = (size_t)sqlite3_value_bytes(arg(i));
  return b ? copy_out(b, n, out, cap) : 0;
}

/* Results of the current call. As with binding, empty text and blobs are
 * set explicitly, since an empty span may arrive as a null pointer, which
 * SQLite takes as NULL. */
void sqx_result_null(void) { sqlite3_result_null(cur_ctx); }
void sqx_result_double(double v) { sqlite3_result_double(cur_ctx, v); }
void sqx_result_int64(int64_t v) { sqlite3_result_int64(cur_ctx, v); }

void sqx_result_text(const uint8_t *p, size_t n) {
  sqlite3_result_text64(cur_ctx, nonnull(p), (sqlite3_uint64)n, SQLITE_TRANSIENT, SQLITE_UTF8);
}

void sqx_result_blob(const uint8_t *p, size_t n) {
  if (n == 0) {
    sqlite3_result_zeroblob(cur_ctx, 0);
    return;
  }
  sqlite3_result_blob64(cur_ctx, p, (sqlite3_uint64)n, SQLITE_TRANSIENT);
}

void sqx_result_error(const uint8_t *p, size_t n) { sqlite3_result_error(cur_ctx, nonnull(p), (int)n); }

/* The SQLite library version, for the notes. */
int64_t sqx_version(uint8_t *out, size_t cap) {
  const char *v = sqlite3_libversion();
  return copy_out(v, strlen(v), out, cap);
}
