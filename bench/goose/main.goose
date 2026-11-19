// sqlite-bench <workload> <database> [N]. Native handles are opaque u64s.
import std;
import os;
import ffi;

extern fn db_open(path: const u8[:], readonly: bool) -> u64;
extern fn db_close(db: u64);
extern fn db_exec(db: u64, sql: const u8[:]);
extern fn db_prepare(db: u64, sql: const u8[:]) -> u64;
extern fn db_next(stmt: u64) -> bool;
extern fn db_finish(stmt: u64);
extern fn db_int(stmt: u64, col: i32) -> i64;
extern fn db_real(stmt: u64, col: i32) -> f64;
extern fn db_text(stmt: u64, col: i32) -> u64;
extern fn db_blob(stmt: u64, col: i32) -> u64;
extern fn db_bytes(stmt: u64, col: i32) -> i64;
extern fn db_bind_int(stmt: u64, col: i32, value: i64);
extern fn db_bind_real(stmt: u64, col: i32, value: f64);
extern fn db_bind_text(stmt: u64, col: i32, value: const u8[:]);
extern fn db_reset(stmt: u64);
extern fn db_register_twice(db: u64);

// The C callback invokes this exported Goose function on this same thread.
export "bench_twice" fn twice(x: i64) -> i64 { return x * 2; }

fn chars(s: const u8[:]) -> i64 {
    var count = 0;
    each_utf8(s) { count += 1; };
    return count;
}

fn insert(db: u64, n: i64) {
    db_exec(db, "pragma journal_mode = wal; pragma synchronous = normal;");
    db_exec(db, "create table t (id integer primary key, n integer, r real, body text)");
    db_exec(db, "begin");
    let add = db_prepare(db, "insert into t (n, r, body) values (?, ?, ?)");
    for i in 1..n + 1 {
        let body = str("row ", i, " ünïcødé ✓ the quick brown fox jumps over the lazy dog 0123456789 abcdefghijklmnop");
        db_bind_int(add, 1, i);
        db_bind_real(add, 2, i * 0.5);
        db_bind_text(add, 3, body);
        assert(!db_next(add));
        db_reset(add);
    }
    db_finish(add);
    db_exec(db, "commit");
    let s = db_prepare(db, "select count(*), sum(n), sum(length(body)) from t");
    assert(db_next(s));
    print(db_int(s, 0), " ", db_int(s, 1), " ", db_int(s, 2));
    db_finish(s);
}

fn read(db: u64) {
    let s = db_prepare(db, "select n, r, body from t");
    var count = 0;
    var sum_n = 0;
    var sum_r = 0.0;
    var length = 0;
    while db_next(s) {
        let n = db_int(s, 0);
        let r = db_real(s, 1);
        let body = ffi::bytes(db_text(s, 2), db_bytes(s, 2));
        count += 1;
        sum_n += n;
        sum_r += r;
        length += chars(body);
    }
    print(count, " ", sum_n, " ", (sum_r * 2.0) as i64, " ", length);
    db_finish(s);
}

fn text(db: u64) {
    let s = db_prepare(db, "select body, data from t2");
    var count = 0;
    var length = 0;
    var bytes = 0;
    var sum = 0;
    while db_next(s) {
        let body = ffi::bytes(db_text(s, 0), db_bytes(s, 0));
        let data = ffi::bytes(db_blob(s, 1), db_bytes(s, 1));
        count += 1;
        length += chars(body);
        bytes += data.len;
        sum += data[0] as i64 + data[data.len >> 1] + data[data.len - 1];
    }
    print(count, " ", length, " ", bytes, " ", sum);
    db_finish(s);
}

fn main() {
    let a = args();
    guard a.len >= 3 else { abort("usage: goose-bench <workload> <database> [N]"); }
    let w = a[1];
    var n = 0;
    if a.len > 3 { let v, ok = parse_int(a[3]); if ok { n = v; } }
    let db = db_open(a[2], w != "insert" && w != "version");
    if w == "insert" { insert(db, n); }
    else if w == "read" { read(db); }
    else if w == "text" { text(db); }
    else if w == "version" {
        let s = db_prepare(db, "select sqlite_version()");
        assert(db_next(s));
        print(ffi::cstr(db_text(s, 0)));
        db_finish(s);
    } else if w == "startup" {
        let s = db_prepare(db, "select count(*), sum(length(body)) from notes where id <= 100");
        assert(db_next(s));
        print(db_int(s, 0), " ", db_int(s, 1));
        db_finish(s);
    } else if w == "udf" {
        db_register_twice(db);
        let s = db_prepare(db, "select cast(sum(twice(n)) as integer) from t");
        assert(db_next(s));
        print(db_int(s, 0));
        db_finish(s);
    } else { abort("unknown workload"); }
    db_close(db);
}
