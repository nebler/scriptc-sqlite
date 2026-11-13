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
 * keeps state between calls, so connections and statements may live on any
 * scriptc thread, one thread at a time each. */
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include "sqlite3.h"

static int64_t copy_out(const void *src, size_t len, uint8_t *out, size_t cap) {
  if (len > 0 && len <= cap) memcpy(out, src, len);
  return (int64_t)len;
}

/* The FFI hands over a span (pointer, length) without a terminating NUL, and
 * an empty span may come with a null pointer. */
static const char *nonnull(const uint8_t *p) { return p ? (const char *)p : ""; }

/* ── connections ─────────────────────────────────────────────────────── */

/* Opens `path` (UTF-8 span). Returns the handle; on failure the handle may
 * still be non-null so that the error can be read, and must be closed. The
 * defaults follow Node's node:sqlite: foreign keys on, double-quoted string
 * literals off. */
void *sqx_open(const uint8_t *path, size_t path_len, int32_t read_only) {
  char name[4096];
  if (path_len >= sizeof name) return NULL;
  if (path_len) memcpy(name, path, path_len);
  name[path_len] = 0;
  sqlite3 *db = NULL;
  int flags = read_only ? SQLITE_OPEN_READONLY : (SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE);
  int rc = sqlite3_open_v2(name, &db, flags | SQLITE_OPEN_URI, NULL);
  if (rc == SQLITE_OK && db) {
    sqlite3_db_config(db, SQLITE_DBCONFIG_ENABLE_FKEY, 1, (int *)NULL);
    sqlite3_db_config(db, SQLITE_DBCONFIG_DQS_DML, 0, (int *)NULL);
    sqlite3_db_config(db, SQLITE_DBCONFIG_DQS_DDL, 0, (int *)NULL);
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

int64_t sqx_sql(void *stmt, uint8_t *out, size_t cap) {
  const char *s = sqlite3_sql((sqlite3_stmt *)stmt);
  return s ? copy_out(s, strlen(s), out, cap) : 0;
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

/* SQLITE_INTEGER 1, FLOAT 2, TEXT 3, BLOB 4, NULL 5. */
int32_t sqx_column_type(void *stmt, int32_t i) { return sqlite3_column_type((sqlite3_stmt *)stmt, i); }

int64_t sqx_column_int64(void *stmt, int32_t i) { return sqlite3_column_int64((sqlite3_stmt *)stmt, i); }

double sqx_column_double(void *stmt, int32_t i) { return sqlite3_column_double((sqlite3_stmt *)stmt, i); }

/* Text and blob values: the full length is returned, at most `cap` bytes are
 * copied. The value stays valid until the next step, reset or finalize, so
 * a second call with a bigger buffer sees the same bytes. Text is read as
 * UTF-8 first, then measured, as SQLite's documentation requires. */
int64_t sqx_column_text(void *stmt, int32_t i, uint8_t *out, size_t cap) {
  const unsigned char *t = sqlite3_column_text((sqlite3_stmt *)stmt, i);
  size_t n = (size_t)sqlite3_column_bytes((sqlite3_stmt *)stmt, i);
  return t ? copy_out(t, n, out, cap) : 0;
}

int64_t sqx_column_blob(void *stmt, int32_t i, uint8_t *out, size_t cap) {
  const void *b = sqlite3_column_blob((sqlite3_stmt *)stmt, i);
  size_t n = (size_t)sqlite3_column_bytes((sqlite3_stmt *)stmt, i);
  return b ? copy_out(b, n, out, cap) : 0;
}

/* The SQLite library version, for the notes. */
int64_t sqx_version(uint8_t *out, size_t cap) {
  const char *v = sqlite3_libversion();
  return copy_out(v, strlen(v), out, cap);
}
