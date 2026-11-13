// One test, run unchanged under Node (where "#sqlite" is node:sqlite) and
// as a scriptc binary (where it is ./src/sqlite.ts). run.sh compares the two
// outputs byte for byte. Every value is printed through show(), so the
// output does not depend on how either runtime formats objects.
import { DatabaseSync } from "#sqlite";

type Value = null | number | bigint | string | Uint8Array | undefined;

function hex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, "0");
  return out;
}

function digest(text: string): string {
  // A short, stable fingerprint of a long string: length and a 32-bit hash
  // of its UTF-16 code units.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `len ${text.length} hash ${h.toString(16)}`;
}

function show(value: Value): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "number") return `num ${Object.is(value, -0) ? "-0" : String(value)}`;
  if (typeof value === "bigint") return `big ${value}n`;
  if (typeof value === "string") {
    if (value.length > 200) return `str ${digest(value)}`;
    return `str ${JSON.stringify(value)}`;
  }
  if (value.length > 64) {
    let sum = 0;
    for (let i = 0; i < value.length; i++) sum = (sum * 31 + value[i]!) >>> 0;
    return `blob len ${value.length} sum ${sum.toString(16)}`;
  }
  return `blob [${hex(value)}]`;
}

function showRow(row: Record<string, Value> | undefined): string {
  if (row === undefined) return "no row";
  const parts: string[] = [];
  for (const key of Object.keys(row)) parts.push(`${key}=${show(row[key])}`);
  return `{ ${parts.join(", ")} }`;
}

function showError(error: unknown): string {
  const e = error as { message: string; code?: string; errcode?: number; errstr?: string };
  const parts = [`code ${e.code}`];
  if (e.errcode !== undefined) parts.push(`errcode ${e.errcode}`);
  if (e.errstr !== undefined) parts.push(`errstr ${JSON.stringify(e.errstr)}`);
  parts.push(`message ${JSON.stringify(e.message)}`);
  return `error ${parts.join(", ")}`;
}

function attempt(label: string, body: () => string): void {
  try {
    console.log(`${label}: ${body()}`);
  } catch (error) {
    console.log(`${label}: ${showError(error)}`);
  }
}

const db = new DatabaseSync(":memory:");
console.log(`open: ${db.isOpen}, in transaction: ${db.isTransaction}`);

// ── every column type ────────────────────────────────────────────────────
db.exec(`
  create table v (
    id integer primary key,
    label text not null,
    i integer, r real, t text, b blob, n
  );
`);
const insert = db.prepare("insert into v (label, i, r, t, b, n) values (?, ?, ?, ?, ?, ?)");

const allBytes = new Uint8Array(256);
for (let i = 0; i < 256; i++) allBytes[i] = i;
const bigBlob = new Uint8Array(1 << 20);
for (let i = 0; i < bigBlob.length; i++) bigBlob[i] = (i * 7 + 3) & 255;
let longText = "";
for (let i = 0; i < 20000; i++) longText += `zeile ${i} ü🙂 `;

const rows: [string, Value, Value, Value, Value, Value][] = [
  ["integers", 0n, 1.5, "plain", new Uint8Array([1, 2, 3]), null],
  ["negatives", -1n, -0.25, "with\ttab\nnewline", new Uint8Array([255]), null],
  ["safe edge", 9007199254740991n, 1e308, "Ünïcødé", allBytes, null],
  ["neg safe edge", -9007199254740991n, -1e-308, "日本語のテキスト", new Uint8Array(0), null],
  ["emoji", 42n, Infinity, "🙂👍🏽🏳️‍🌈 family 👨‍👩‍👧", new Uint8Array([0, 0, 0]), null],
  ["empty", 7n, -Infinity, "", new Uint8Array(0), null],
  ["embedded nul", 8n, 3.141592653589793, "a\u0000b\u0000", new Uint8Array([0]), null],
  ["nulls", null, null, null, null, null],
  ["number as real", 5, 5, "5", new Uint8Array([53]), 5],
  ["negative zero", 0n, -0, "-0", new Uint8Array([45, 48]), -0],
  ["nan becomes null", 1n, NaN, "NaN", new Uint8Array([1]), NaN],
  ["long values", 2n, 0.1 + 0.2, longText, bigBlob, "x".repeat(70000)],
  ["combining", 3n, 2.5e-10, "é vs é, Å vs Å", new Uint8Array([0xc3, 0xa9]), "Ω"],
];
for (const [label, i, r, t, b, n] of rows) {
  const result = insert.run(label, i, r, t, b, n);
  console.log(`insert ${label}: changes ${show(result.changes)}, rowid ${show(result.lastInsertRowid)}`);
}

const select = db.prepare(
  "select id, label, i, typeof(i) ti, r, typeof(r) tr, t, typeof(t) tt, length(t) lt, b, typeof(b) tb, length(b) lb, n, typeof(n) tn from v order by id",
);
for (const row of select.all()) console.log(showRow(row as Record<string, Value>));

// ── 64-bit integers ──────────────────────────────────────────────────────
db.exec("create table big (k text primary key, v integer)");
const putBig = db.prepare("insert into big values (?, ?)");
putBig.run("max", 9223372036854775807n);
putBig.run("min", -9223372036854775808n);
putBig.run("past safe", 9007199254740993n);
putBig.run("small", 12n);
const getBig = db.prepare("select v, typeof(v) t from big where k = ?");
for (const k of ["max", "min", "past safe", "small"]) attempt(`read ${k} as number`, () => showRow(getBig.get(k) as Record<string, Value>));
getBig.setReadBigInts(true);
for (const k of ["max", "min", "past safe", "small"]) attempt(`read ${k} as bigint`, () => showRow(getBig.get(k) as Record<string, Value>));
attempt("bind 2^63", () => show(putBig.run("too big", 9223372036854775808n).changes));
attempt("bind -2^63-1", () => show(putBig.run("too small", -9223372036854775809n).changes));
attempt("sum overflow", () => showRow(db.prepare("select sum(v) s from big").get() as Record<string, Value>));
attempt("arithmetic", () => showRow(db.prepare("select 9007199254740993 + 0 a, 2 * 4611686018427387904.0 b").get() as Record<string, Value>));

const bigDb = new DatabaseSync(":memory:", { readBigInts: true });
attempt("readBigInts option", () => showRow(bigDb.prepare("select 1 a, 2.5 b, ? c").get(3n) as Record<string, Value>));
attempt("readBigInts run", () => {
  bigDb.exec("create table t (a)");
  const r = bigDb.prepare("insert into t values (?)").run(1);
  return `changes ${show(r.changes)}, rowid ${show(r.lastInsertRowid)}`;
});
bigDb.close();

// ── binding ──────────────────────────────────────────────────────────────
attempt("typeof bound values", () =>
  showRow(db.prepare("select typeof(?) a, typeof(?) b, typeof(?) c, typeof(?) d, typeof(?) e, typeof(?) f, typeof(?) g").get(1, 1.5, 1n, "s", new Uint8Array(0), null, true) as Record<string, Value>),
);
attempt("booleans", () => showRow(db.prepare("select ? t, ? f").get(true, false) as Record<string, Value>));
attempt("named", () => showRow(db.prepare("select $a a, :b b, @c c").get({ a: 1n, b: "two", c: null }) as Record<string, Value>));
attempt("named and positional", () => showRow(db.prepare("select $a a, ? b").get({ a: "named" }, "positional") as Record<string, Value>));
attempt("numbered", () => showRow(db.prepare("select ?1 a, ?1 b, ?2 c").get("x", "y") as Record<string, Value>));
attempt("unbound is null", () => showRow(db.prepare("select ? a, ? b").get("only one") as Record<string, Value>));
attempt("too many values", () => showRow(db.prepare("select ? a").get(1, 2) as Record<string, Value>));
attempt("undefined value", () => showRow(db.prepare("select ? a").get(undefined) as Record<string, Value>));
attempt("unknown named", () => showRow(db.prepare("select $a a").get({ z: 1 }) as Record<string, Value>));
attempt("duplicate column names", () => showRow(db.prepare("select 1 x, 2 x, 3 y").get() as Record<string, Value>));
attempt("no row", () => showRow(db.prepare("select 1 where 0").get() as Record<string, Value> | undefined));
attempt("no rows", () => `${db.prepare("select 1 where 0").all().length} rows`);
attempt("expression column names", () => showRow(db.prepare("select 1+1, 'a' || 'b', ?").get(9) as Record<string, Value>));
attempt("statement reused", () => {
  const s = db.prepare("select ? * 2 x");
  return [1, 2, 3].map((k) => show((s.get(k) as Record<string, Value>)["x"])).join(" ");
});
attempt("sourceSQL", () => JSON.stringify(db.prepare("select  1 -- comment").sourceSQL));
attempt("exec several", () => {
  db.exec("create table s (a); insert into s values (1); insert into s values (2);");
  return showRow(db.prepare("select count(*) c, sum(a) t from s").get() as Record<string, Value>);
});
attempt("functions", () =>
  showRow(db.prepare("select json_extract('{\"a\":[1,2,{\"b\":\"ü\"}]}', '$.a[2].b') j, upper('straße') u, hex(zeroblob(2)) h, round(sqrt(2), 6) m").get() as Record<string, Value>),
);

// ── errors ───────────────────────────────────────────────────────────────
attempt("syntax error", () => {
  db.prepare("selec 1");
  return "prepared";
});
attempt("no such table", () => {
  db.exec("insert into nope values (1)");
  return "ran";
});
attempt("syntax error in exec tail", () => {
  db.exec("select 1; selec 2");
  return "ran";
});
attempt("unique", () => show(db.prepare("insert into big values ('max', 1)").run().changes));
attempt("not null", () => show(db.prepare("insert into v (label) values (null)").run().changes));
attempt("check", () => {
  db.exec("create table c (x integer check (x > 0))");
  return show(db.prepare("insert into c values (?)").run(-1n).changes);
});
attempt("foreign key", () => {
  db.exec("create table parent (id integer primary key); create table child (p integer references parent(id))");
  return show(db.prepare("insert into child values (99)").run().changes);
});
attempt("double-quoted string", () => showRow(db.prepare('select "not a column" x').get() as Record<string, Value>));
attempt("empty statement", () => {
  db.prepare("   ");
  return "prepared";
});
attempt("open bad path", () => {
  const bad = new DatabaseSync("/nonexistent/dir/x.db");
  return `open ${bad.isOpen}`;
});
attempt("error then reuse", () => {
  const s = db.prepare("select 10 / ? x");
  try {
    s.get(undefined);
  } catch {
    // the statement must still work afterwards
  }
  return showRow(s.get(4) as Record<string, Value>);
});

// ── transactions ─────────────────────────────────────────────────────────
db.exec("create table acct (name text primary key, cents integer not null check (cents >= 0))");
db.exec("insert into acct values ('a', 100), ('b', 0)");
const balances = db.prepare("select name, cents from acct order by name");
const showBalances = () => balances.all().map((r) => showRow(r as Record<string, Value>)).join(" ");
const move = db.prepare("update acct set cents = cents + ? where name = ?");

function transfer(cents: bigint): string {
  db.exec("begin");
  const inside = db.isTransaction;
  try {
    move.run(-cents, "a");
    move.run(cents, "b");
    db.exec("commit");
    return `committed (in transaction ${inside})`;
  } catch (error) {
    db.exec("rollback");
    return `rolled back (in transaction ${inside}) after ${showError(error)}`;
  }
}
console.log(`before: ${showBalances()}`);
console.log(`transfer 30: ${transfer(30n)}; now ${showBalances()}; in transaction ${db.isTransaction}`);
console.log(`transfer 500: ${transfer(500n)}; now ${showBalances()}; in transaction ${db.isTransaction}`);
attempt("explicit rollback", () => {
  db.exec("begin");
  db.prepare("delete from acct").run();
  const during = db.prepare("select count(*) n from acct").get() as Record<string, Value>;
  db.exec("rollback");
  return `during ${showRow(during)}, after ${showBalances()}`;
});
attempt("nested begin", () => {
  db.exec("begin");
  try {
    db.exec("begin");
    return "nested";
  } finally {
    db.exec("rollback");
  }
});
attempt("savepoint", () => {
  db.exec("begin; savepoint s1; update acct set cents = 0; rollback to s1; release s1; commit");
  return showBalances();
});
attempt("commit without begin", () => {
  db.exec("commit");
  return "committed";
});

// ── closing ──────────────────────────────────────────────────────────────
const leftOver = db.prepare("select 1 x");
db.close();
console.log(`closed: open ${db.isOpen}`);
attempt("exec after close", () => {
  db.exec("select 1");
  return "ran";
});
attempt("statement after close", () => showRow(leftOver.get() as Record<string, Value>));
attempt("close twice", () => {
  db.close();
  return "closed";
});
const reopened = new DatabaseSync(":memory:", { open: false });
attempt("not yet open", () => {
  reopened.exec("select 1");
  return "ran";
});
reopened.open();
attempt("opened later", () => showRow(reopened.prepare("select 'yes' ok").get() as Record<string, Value>));
reopened.close();
console.log("done");
