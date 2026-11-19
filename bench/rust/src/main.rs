//! The benchmark workloads in Rust on rusqlite (SQLite compiled in with the
//! `bundled` feature). See ../../sqlite-bench.mts for the workloads and
//! checksums.
//!
//!     rust-bench <workload> <database> [N]
use rusqlite::functions::FunctionFlags;
use rusqlite::{params, Connection, OpenFlags};

const FILLER: &str = "ünïcødé ✓ the quick brown fox jumps over the lazy dog 0123456789 abcdefghijklmnop";

fn body(i: i64) -> String {
    format!("row {} {}", i, FILLER)
}

fn open_ro(path: &str) -> Connection {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).expect("open")
}

fn version(path: &str) -> String {
    let db = Connection::open(path).expect("open");
    db.query_row("select sqlite_version()", [], |r| r.get(0)).expect("version")
}

fn startup(path: &str) -> String {
    let db = open_ro(path);
    let (c, s): (i64, i64) = db
        .query_row("select count(*), sum(length(body)) from notes where id <= 100", [], |r| Ok((r.get(0)?, r.get(1)?)))
        .expect("startup");
    format!("{} {}", c, s)
}

fn insert(path: &str, n: i64) -> String {
    let mut db = Connection::open(path).expect("open");
    db.execute_batch("pragma journal_mode = wal; pragma synchronous = normal;").expect("pragmas");
    db.execute("create table t (id integer primary key, n integer, r real, body text)", []).expect("create");
    let tx = db.transaction().expect("begin");
    {
        let mut add = tx.prepare("insert into t (n, r, body) values (?, ?, ?)").expect("prepare");
        for i in 1..=n {
            add.execute(params![i, i as f64 * 0.5, body(i)]).expect("insert");
        }
    }
    tx.commit().expect("commit");
    let (c, s, l): (i64, i64, i64) = db
        .query_row("select count(*), sum(n), sum(length(body)) from t", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .expect("check");
    format!("{} {} {}", c, s, l)
}

fn read(path: &str) -> String {
    let db = open_ro(path);
    let mut stmt = db.prepare("select n, r, body from t").expect("prepare");
    let mut rows = stmt.query([]).expect("query");
    let (mut count, mut sum_n, mut chars) = (0i64, 0i64, 0i64);
    let mut sum_r = 0f64;
    while let Some(row) = rows.next().expect("row") {
        let n: i64 = row.get(0).expect("n");
        let r: f64 = row.get(1).expect("r");
        let b: String = row.get(2).expect("body");
        count += 1;
        sum_n += n;
        sum_r += r;
        chars += b.chars().count() as i64;
    }
    format!("{} {} {} {}", count, sum_n, (sum_r * 2.0) as i64, chars)
}

fn text(path: &str) -> String {
    let db = open_ro(path);
    let mut stmt = db.prepare("select body, data from t2").expect("prepare");
    let mut rows = stmt.query([]).expect("query");
    let (mut count, mut chars, mut bytes, mut sum) = (0i64, 0i64, 0i64, 0i64);
    while let Some(row) = rows.next().expect("row") {
        let b: String = row.get(0).expect("body");
        let d: Vec<u8> = row.get(1).expect("data");
        count += 1;
        chars += b.chars().count() as i64;
        bytes += d.len() as i64;
        sum += d[0] as i64 + d[d.len() >> 1] as i64 + d[d.len() - 1] as i64;
    }
    format!("{} {} {} {}", count, chars, bytes, sum)
}

fn udf(path: &str) -> String {
    let db = open_ro(path);
    db.create_scalar_function("twice", 1, FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC, |ctx| {
        Ok(ctx.get::<i64>(0)? * 2)
    })
    .expect("function");
    let s: i64 = db.query_row("select cast(sum(twice(n)) as integer) from t", [], |r| r.get(0)).expect("udf");
    s.to_string()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: rust-bench <workload> <database> [N]");
        std::process::exit(2);
    }
    let path = args[2].as_str();
    let n: i64 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(0);
    let out = match args[1].as_str() {
        "version" => version(path),
        "startup" => startup(path),
        "insert" => insert(path, n),
        "read" => read(path),
        "text" => text(path),
        "udf" => udf(path),
        other => {
            eprintln!("unknown workload {:?}", other);
            std::process::exit(2);
        }
    };
    println!("{}", out);
}
