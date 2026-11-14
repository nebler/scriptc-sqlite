// Only ABI adaptation and error handling; all workload loops live in Goose.
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "sqlite3.h"

typedef struct { const uint8_t *data; int64_t len; } bytes;
#define DB(h) ((sqlite3 *)(uintptr_t)(h))
#define ST(h) ((sqlite3_stmt *)(uintptr_t)(h))
static void check(sqlite3 *db, int rc) {
    if (rc != SQLITE_OK) {
        fprintf(stderr, "SQLite %d: %s\n", rc, db ? sqlite3_errmsg(db) : sqlite3_errstr(rc));
        exit(1);
    }
}
uint64_t db_open(bytes path, _Bool readonly) {
    char *p = malloc((size_t)path.len + 1);
    if (!p) { fputs("out of memory\n", stderr); exit(1); }
    memcpy(p, path.data, (size_t)path.len);
    p[path.len] = 0;
    sqlite3 *db = NULL;
    int rc = sqlite3_open_v2(p, &db, (readonly ? SQLITE_OPEN_READONLY : SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE) | SQLITE_OPEN_NOMUTEX, NULL);
    free(p);
    check(db, rc);
    return (uintptr_t)db;
}
void db_close(uint64_t db) { check(DB(db), sqlite3_close(DB(db))); }
uint64_t db_prepare(uint64_t db, bytes sql) {
    sqlite3_stmt *s = NULL;
    check(DB(db), sqlite3_prepare_v2(DB(db), (const char *)sql.data, (int)sql.len, &s, NULL));
    return (uintptr_t)s;
}
void db_exec(uint64_t db, bytes sql) {
    // sqlite3_exec needs a terminated string, unlike prepare_v2.
    char *p = malloc((size_t)sql.len + 1);
    if (!p) { fputs("out of memory\n", stderr); exit(1); }
    memcpy(p, sql.data, (size_t)sql.len); p[sql.len] = 0;
    int rc = sqlite3_exec(DB(db), p, NULL, NULL, NULL);
    free(p); check(DB(db), rc);
}
_Bool db_next(uint64_t s) {
    int rc = sqlite3_step(ST(s));
    if (rc == SQLITE_ROW) return 1;
    if (rc != SQLITE_DONE) check(sqlite3_db_handle(ST(s)), rc);
    return 0;
}
void db_finish(uint64_t s) {
    sqlite3 *db = sqlite3_db_handle(ST(s));
    check(db, sqlite3_finalize(ST(s)));
}
int64_t db_int(uint64_t s, int32_t c) { return sqlite3_column_int64(ST(s), c); }
double db_real(uint64_t s, int32_t c) { return sqlite3_column_double(ST(s), c); }
uint64_t db_text(uint64_t s, int32_t c) { return (uintptr_t)sqlite3_column_text(ST(s), c); }
uint64_t db_blob(uint64_t s, int32_t c) { return (uintptr_t)sqlite3_column_blob(ST(s), c); }
int64_t db_bytes(uint64_t s, int32_t c) { return sqlite3_column_bytes(ST(s), c); }
void db_bind_int(uint64_t s, int32_t c, int64_t v) { check(sqlite3_db_handle(ST(s)), sqlite3_bind_int64(ST(s), c, v)); }
void db_bind_real(uint64_t s, int32_t c, double v) { check(sqlite3_db_handle(ST(s)), sqlite3_bind_double(ST(s), c, v)); }
void db_bind_text(uint64_t s, int32_t c, bytes v) {
    check(sqlite3_db_handle(ST(s)), sqlite3_bind_text(ST(s), c, (const char *)v.data, (int)v.len, SQLITE_TRANSIENT));
}
void db_reset(uint64_t s) { check(sqlite3_db_handle(ST(s)), sqlite3_reset(ST(s))); }
extern int64_t bench_twice(int64_t x);
static void twice(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
    (void)argc;
    sqlite3_result_int64(ctx, bench_twice(sqlite3_value_int64(argv[0])));
}
void db_register_twice(uint64_t db) {
    check(DB(db), sqlite3_create_function_v2(DB(db), "twice", 1, SQLITE_UTF8 | SQLITE_DETERMINISTIC, NULL, twice, NULL, NULL, NULL));
}
