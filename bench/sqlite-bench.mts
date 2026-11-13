// The benchmark workloads in TypeScript, on "#sqlite": node:sqlite under
// Node (and Deno), this package's module when built with scriptc. The same
// workloads exist for Bun (bun-bench.ts), Go (go/) and Rust (rust/); each
// prints one checksum line, which bench/run.mjs compares across them.
//
//   sqlite-bench <workload> <database> [N]
//
// Workloads (bench/README.md): version, startup, insert, read, text, udf.
// Every checksum is printed as integers, so languages print it alike.
import { DatabaseSync } from "#sqlite";

/** The body text of row i, as in every implementation: about 100
 * characters, all in the Basic Multilingual Plane. */
const FILLER = "ünïcødé ✓ the quick brown fox jumps over the lazy dog 0123456789 abcdefghijklmnop";

function body(i: number): string {
  return `row ${i} ${FILLER}`;
}

type CountRow = { c: number; s: number; l: number };
type ReadRow = { n: number; r: number; body: string };
type TextRow = { body: string; data: Uint8Array };
type VersionRow = { v: string };
type SumRow = { s: number };

function version(path: string): string {
  const db = new DatabaseSync(path);
  const row = db.prepare("select sqlite_version() v").get() as VersionRow;
  db.close();
  return row.v;
}

function startup(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  const row = db.prepare("select count(*) c, sum(length(body)) s, 0 l from notes where id <= 100").get() as CountRow;
  db.close();
  return `${row.c} ${row.s}`;
}

function insert(path: string, n: number): string {
  const db = new DatabaseSync(path);
  db.exec("pragma journal_mode = wal; pragma synchronous = normal");
  db.exec("create table t (id integer primary key, n integer, r real, body text)");
  const add = db.prepare("insert into t (n, r, body) values (?, ?, ?)");
  db.exec("begin");
  for (let i = 1; i <= n; i++) add.run(i, i * 0.5, body(i));
  db.exec("commit");
  const row = db.prepare("select count(*) c, sum(n) s, sum(length(body)) l from t").get() as CountRow;
  db.close();
  return `${row.c} ${row.s} ${row.l}`;
}

function read(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  let rows = 0;
  let sumN = 0;
  let sumR = 0;
  let chars = 0;
  for (const row of db.prepare("select n, r, body from t").iterate()) {
    const r = row as ReadRow;
    rows++;
    sumN += r.n;
    sumR += r.r;
    chars += r.body.length;
  }
  db.close();
  return `${rows} ${sumN} ${sumR * 2} ${chars}`;
}

function text(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  let rows = 0;
  let chars = 0;
  let bytes = 0;
  let check = 0;
  for (const row of db.prepare("select body, data from t2").iterate()) {
    const r = row as TextRow;
    const d = r.data;
    rows++;
    chars += r.body.length;
    bytes += d.length;
    check += d[0]! + d[d.length >> 1]! + d[d.length - 1]!;
  }
  db.close();
  return `${rows} ${chars} ${bytes} ${check}`;
}

function udf(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  db.function("twice", { deterministic: true }, (x) => (x as number) * 2);
  const row = db.prepare("select cast(sum(twice(n)) as integer) s from t").get() as SumRow;
  db.close();
  return `${row.s}`;
}

// The same reads through this package's typed reads (StatementSync.map and
// forEach, not in node:sqlite): columns read by index with their types, no
// row object. Run when a fifth argument says "typed".
function startupTyped(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  const row = db
    .prepare("select count(*) c, sum(length(body)) s, 0 l from notes where id <= 100")
    .map((c): CountRow => ({ c: c.number(0), s: c.number(1), l: c.number(2) }))[0]!;
  db.close();
  return `${row.c} ${row.s}`;
}

function readTyped(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  const sum = { rows: 0, n: 0, r: 0, chars: 0 };
  db.prepare("select n, r, body from t").forEach((c) => {
    sum.rows++;
    sum.n += c.number(0);
    sum.r += c.number(1);
    sum.chars += c.text(2).length;
  });
  db.close();
  return `${sum.rows} ${sum.n} ${sum.r * 2} ${sum.chars}`;
}

function textTyped(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  const sum = { rows: 0, chars: 0, bytes: 0, check: 0 };
  db.prepare("select body, data from t2").forEach((c) => {
    const d = c.blob(1);
    sum.rows++;
    sum.chars += c.text(0).length;
    sum.bytes += d.length;
    sum.check += d[0]! + d[d.length >> 1]! + d[d.length - 1]!;
  });
  db.close();
  return `${sum.rows} ${sum.chars} ${sum.bytes} ${sum.check}`;
}

const workload = process.argv[2] ?? "";
const path = process.argv[3] ?? "";
const n = Number(process.argv[4] ?? "0");
const typed = process.argv[5] === "typed";
if (workload === "version") console.log(version(path));
else if (workload === "startup") console.log(typed ? startupTyped(path) : startup(path));
else if (workload === "insert") console.log(insert(path, n));
else if (workload === "read") console.log(typed ? readTyped(path) : read(path));
else if (workload === "text") console.log(typed ? textTyped(path) : text(path));
else if (workload === "udf") console.log(udf(path));
else {
  console.error(`unknown workload ${JSON.stringify(workload)}`);
  process.exit(2);
}
