// One test, run unchanged under Node (where "#sqlite" is node:sqlite) and
// as a scriptc binary (where it is ./src/sqlite.ts). run.sh compares the two
// outputs byte for byte. Every value is printed through show(), so the
// output does not depend on how either runtime formats objects.
import { DatabaseSync, backup } from "#sqlite";
import { mkdirSync, rmSync } from "node:fs";

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
putBig.run("past safe neg", -9007199254740993n);
putBig.run("small", 12n);
const getBig = db.prepare("select v, typeof(v) t from big where k = ?");
// "min" (-2^63) is left out as a number: Node itself answers differently on
// Linux (rounds it) and macOS (refuses it), so it cannot be the reference.
for (const k of ["max", "past safe", "past safe neg", "small"]) attempt(`read ${k} as number`, () => showRow(getBig.get(k) as Record<string, Value>));
getBig.setReadBigInts(true);
for (const k of ["max", "min", "past safe", "past safe neg", "small"]) attempt(`read ${k} as bigint`, () => showRow(getBig.get(k) as Record<string, Value>));
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

// ── day 2: iterate, arrays, columns, expanded SQL, options, disposal ─────
{
  const d = new DatabaseSync(":memory:");
  d.exec("create table pets (id integer primary key, name text not null, kind text, born integer, weight real)");
  const add = d.prepare("insert into pets (name, kind, born, weight) values (?, ?, ?, ?)");
  const pets: [string, string | null, bigint, number][] = [
    ["Mia", "cat", 2019n, 4.25],
    ["Bo", "dog", 2016n, 21.5],
    ["Ünal", null, 2021n, 0.03],
    ["Kiki", "parrot", 2000n, 0.4],
  ];
  for (const [name, kind, born, weight] of pets) add.run(name, kind, born, weight);

  const byAge = d.prepare("select name, born from pets order by born");
  attempt("null prototype", () => String(Object.getPrototypeOf(byAge.get()) === null));
  attempt("iterate", () => {
    const names: string[] = [];
    for (const row of byAge.iterate()) names.push(show((row as Record<string, Value>)["name"]));
    return names.join(" ");
  });
  attempt("iterate with parameters", () => {
    const it = d.prepare("select name from pets where born > ? order by id").iterate(2017n);
    const first = it.next();
    const second = it.next();
    const third = it.next();
    return `${first.done} ${showRow(first.value as Record<string, Value>)} ${second.done} ${third.done} ${JSON.stringify(third.value)}`;
  });
  attempt("iterator is iterable", () => {
    const it = byAge.iterate();
    return `${it[Symbol.iterator]() === it}`;
  });
  attempt("iterate then return", () => {
    const it = byAge.iterate();
    it.next();
    return `${JSON.stringify(it.return!())} then ${JSON.stringify(it.next())}`;
  });
  attempt("break out of iterate, then reuse", () => {
    let seen = 0;
    for (const row of byAge.iterate()) {
      seen++;
      if (seen === 2) break;
      show((row as Record<string, Value>)["name"]);
    }
    return `${seen} seen, then ${byAge.all().length} rows`;
  });
  attempt("call during iterate", () => {
    const it = byAge.iterate();
    it.next();
    byAge.get();
    return JSON.stringify(it.next());
  });
  attempt("spread iterate", () => `${[...byAge.iterate()].length} rows`);
  attempt("empty iterate", () => JSON.stringify(d.prepare("select 1 where 0").iterate().next()));

  // Node's returnArrays is left out of the scriptc module (see NOTES.md), so
  // it is not compared here.

  attempt("columns", () =>
    JSON.stringify(d.prepare("select p.id, name as n, born + 1 as next, 'x' lit, weight from pets p").columns()),
  );
  attempt("columns of no-result statement", () => JSON.stringify(add.columns()));

  attempt("expandedSQL unbound", () => d.prepare("select ? a, $b b, :c c").expandedSQL);
  attempt("expandedSQL bound", () => {
    const s = d.prepare("select ? a, ? b, ? c, ? d, ? e");
    s.get(1, "it's", 2n, null, new Uint8Array([0xab, 0xcd]));
    return s.expandedSQL;
  });

  attempt("bare names off", () => {
    const s = d.prepare("select $a a");
    s.setAllowBareNamedParameters(false);
    return showRow(s.get({ a: 1 }) as Record<string, Value>);
  });
  attempt("bare names off, prefixed key", () => {
    const s = d.prepare("select $a a");
    s.setAllowBareNamedParameters(false);
    return showRow(s.get({ $a: 1 }) as Record<string, Value>);
  });
  attempt("unknown names allowed", () => {
    const s = d.prepare("select $a a");
    s.setAllowUnknownNamedParameters(true);
    return showRow(s.get({ a: 1, extra: 2 }) as Record<string, Value>);
  });
  attempt("options for named parameters", () => {
    const a = new DatabaseSync(":memory:", { allowBareNamedParameters: false });
    try {
      return showRow(a.prepare("select :x x").get({ x: 1 }) as Record<string, Value>);
    } finally {
      a.close();
    }
  });

  attempt("foreign keys off", () => {
    const a = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
    a.exec("create table p (id integer primary key); create table c (p integer references p(id)); insert into c values (5)");
    a.close();
    return "inserted";
  });
  attempt("double-quoted strings on", () => {
    const a = new DatabaseSync(":memory:", { enableDoubleQuotedStringLiterals: true });
    const row = a.prepare('select "lit" x').get() as Record<string, Value>;
    a.close();
    return showRow(row);
  });
  attempt("timeout option", () => {
    const a = new DatabaseSync(":memory:", { timeout: 250 });
    a.close();
    return "ok";
  });
  attempt("bad timeout", () => {
    new DatabaseSync(":memory:", { timeout: 1.5 });
    return "accepted";
  });
  // A wrongly typed boolean option ({ readOnly: "yes" as unknown as boolean })
  // is not compared: scriptc's own run-time type check stops the string
  // before the module sees it, with scriptc's message (see NOTES.md).
  attempt("read-only", () => {
    const a = new DatabaseSync(":memory:", { readOnly: true });
    try {
      a.exec("create table t (x)");
      return "created";
    } finally {
      a.close();
    }
  });

  attempt("statement close", () => {
    const s = d.prepare("select 1 x");
    s.close();
    return showRow(s.get() as Record<string, Value>);
  });
  attempt("statement close twice", () => {
    const s = d.prepare("select 1 x");
    s.close();
    s.close();
    return "closed twice";
  });
  attempt("statement dispose twice", () => {
    const s = d.prepare("select 1 x");
    s[Symbol.dispose]();
    s[Symbol.dispose]();
    return "ok";
  });
  attempt("using", () => {
    let kept: { get(): unknown } | null = null;
    {
      using s = d.prepare("select 'inside' x");
      kept = s;
      show((s.get() as Record<string, Value>)["x"]);
    }
    try {
      kept.get();
      return "still usable";
    } catch (error) {
      return `after block: ${showError(error)}`;
    }
  });
  attempt("using database", () => {
    let outer: { isOpen: boolean } | null = null;
    {
      using a = new DatabaseSync(":memory:");
      outer = a;
    }
    return `open after block: ${outer.isOpen}`;
  });
  attempt("dispose closed database", () => {
    const a = new DatabaseSync(":memory:");
    a.close();
    a[Symbol.dispose]();
    return `open ${a.isOpen}`;
  });
  attempt("prepare in a loop", () => {
    // Many statement objects, few distinct texts: works the same in both
    // runtimes; run.sh checks separately that scriptc keeps a bounded number
    // of SQLite statements here.
    let total = 0;
    for (let i = 0; i < 5000; i++) {
      const row = d.prepare(`select ${i % 50} + ? v`).get(1) as Record<string, Value>;
      total += row["v"] as number;
    }
    return `total ${total}`;
  });
  attempt("iterator after database close", () => {
    const a = new DatabaseSync(":memory:");
    const it = a.prepare("select 1 x union all select 2").iterate();
    it.next();
    a.close();
    return JSON.stringify(it.next());
  });
  attempt("statement after reopen", () => {
    const a = new DatabaseSync(":memory:");
    const s = a.prepare("select 1 x");
    a.close();
    a.open();
    try {
      return showRow(s.get() as Record<string, Value>);
    } finally {
      a.close();
    }
  });
  d.close();
}

// ── day 3: user-defined functions and aggregates ─────────────────────────
// Functions written without parameter types, as most Node code writes them,
// get `SQLOutputValue | undefined` parameters here; functions with typed or
// rest parameters take the module's second signature.
{
  const f = new DatabaseSync(":memory:");
  const row = (sql: string, ...params: (null | number | bigint | string | Uint8Array)[]): string =>
    showRow(f.prepare(sql).get(...params) as Record<string, Value>);
  const rowsOf = (sql: string): string =>
    f
      .prepare(sql)
      .all()
      .map((r) => showRow(r as Record<string, Value>))
      .join(" ");

  // Arguments and results of every type.
  f.function("plus", (a, b) => (a as number) + (b as number));
  f.function("echo", (a) => a ?? null);
  f.function("echoBig", { useBigIntArguments: true }, (a) => a ?? null);
  f.function("kind", (a) => (a === null ? "null" : a instanceof Uint8Array ? "blob" : typeof a));
  attempt("udf plus", () => row("select plus(2, 3) r, typeof(plus(2, 3)) t"));
  attempt("udf plus, wrong argument count", () => row("select plus(1) r"));
  const inputs: [string, null | number | bigint | string | Uint8Array][] = [
    ["integer", 42n],
    ["integer as a number", 42],
    ["negative", -7n],
    ["real", 2.5],
    ["text", "héllo 🙂 👩🏽‍💻"],
    ["empty text", ""],
    ["text with NUL", "a\u0000b"],
    ["blob", allBytes],
    ["empty blob", new Uint8Array(0)],
    ["null", null],
    ["2^53+1", 9007199254740993n],
    ["2^63-1", 9223372036854775807n],
    ["long text", longText],
    ["1 MiB blob", bigBlob],
  ];
  const bigRow = (sql: string, ...params: (null | number | bigint | string | Uint8Array)[]): string => {
    const s = f.prepare(sql);
    s.setReadBigInts(true);
    return showRow(s.get(...params) as Record<string, Value>);
  };
  for (const [label, value] of inputs) {
    attempt(`udf echo ${label}`, () => row("select echo(?) v, typeof(echo(?)) t, kind(?) k", value, value, value));
    attempt(`udf echoBig ${label}`, () => bigRow("select echoBig(?) v, typeof(echoBig(?)) t", value, value));
  }

  // Results Node turns into values, NULL or errors.
  f.function("retUndefined", () => {});
  f.function("retNaN", () => NaN);
  f.function("retNegZero", () => -0);
  f.function("retInf", () => -Infinity);
  f.function("retBool", () => true);
  f.function("retBigMax", () => 9223372036854775807n);
  f.function("retBigTooLarge", () => 9223372036854775808n);
  f.function("retBigTooSmall", () => -9223372036854775809n);
  f.function("retEmptyBlob", () => new Uint8Array(0));
  f.function("retEmptyText", () => "");
  for (const name of ["retUndefined", "retNaN", "retNegZero", "retInf", "retBool", "retBigMax", "retBigTooLarge",
    "retBigTooSmall", "retEmptyBlob", "retEmptyText"]) {
    attempt(`udf ${name}`, () => {
      const s = f.prepare(`select ${name}() v, typeof(${name}()) t`);
      s.setReadBigInts(true);
      return showRow(s.get() as Record<string, Value>);
    });
  }

  // varargs, and a function with fixed parameters called with fewer.
  f.function("countArgs", { varargs: true }, (...xs: Value[]) => xs.length);
  f.function("firstOr", { varargs: true }, (a, b) => (a === undefined ? "none" : b === undefined ? "one" : "two"));
  attempt("udf varargs", () => row("select countArgs() a, countArgs(1) b, countArgs(1, 'x', null, 2.5, x'00') c"));
  attempt("udf varargs, fixed parameters", () => row("select firstOr() a, firstOr(1) b, firstOr(1, 2) c, firstOr(1, 2, 3) d"));
  f.function("countArgs2", (...xs: Value[]) => xs.length);
  attempt("udf rest parameters without varargs", () => row("select countArgs2() a"));
  attempt("udf rest parameters without varargs, one argument", () => row("select countArgs2(1) a"));

  // Same name: a new definition replaces the old one with the same number
  // of arguments; another number of arguments is a separate function.
  f.function("ver", () => "first");
  f.function("ver", () => "second");
  f.function("ver", (a) => `one argument: ${a}`);
  attempt("udf replaced", () => row("select ver() a, ver(1) b"));

  // deterministic: needed in generated columns and indexes.
  let doubled = 0;
  f.function("dbl", (a) => {
    doubled++;
    return (a as number) * 2;
  });
  attempt("udf generated column, not deterministic", () => {
    f.exec("create table g0 (x integer, y as (dbl(x)))");
    return "created";
  });
  attempt("udf index, not deterministic", () => {
    f.exec("create table i0 (x integer); create index i0_dbl on i0 (dbl(x))");
    return "created";
  });
  f.function("dbl", { deterministic: true }, (a) => {
    doubled++;
    return (a as number) * 2;
  });
  attempt("udf generated columns and index, deterministic", () => {
    f.exec(`
      create table g (x integer, y real as (dbl(x)) stored, z as (dbl(x) + 1) virtual);
      create index g_dbl on g (dbl(x));
    `);
    const add1 = f.prepare("insert into g (x) values (?)");
    for (let i = 1; i <= 5; i++) add1.run(i);
    return `${rowsOf("select x, y, z from g order by x")} | via index ${row(
      "select x from g indexed by g_dbl where dbl(x) = 8",
    )} | called ${doubled > 0 ? "yes" : "no"}`;
  });
  attempt("udf generated column after update", () => {
    f.exec("update g set x = x * 10 where x = 2");
    return rowsOf("select x, y, z from g where x = 20");
  });

  // directOnly: not allowed in views, triggers, generated columns, indexes.
  f.function("secret", { directOnly: true, deterministic: true }, () => "s3cret");
  attempt("udf directOnly, direct", () => row("select secret() s"));
  attempt("udf directOnly, in a view", () => {
    f.exec("create view sv as select secret() s");
    return row("select s from sv");
  });
  attempt("udf directOnly, in a trigger", () => {
    f.exec(`
      create table tr (x); create table trlog (s);
      create trigger tr_ins after insert on tr begin insert into trlog values (secret()); end;
      insert into tr values (1);
    `);
    return rowsOf("select s from trlog");
  });
  attempt("udf directOnly, in a generated column", () => {
    f.exec("create table gs (x, y as (secret()))");
    return "created";
  });
  f.function("open", { deterministic: true }, () => "open");
  attempt("udf without directOnly, in a view", () => {
    f.exec("create view ov as select open() s");
    return row("select s from ov");
  });

  // A thrown exception comes out of the call that ran the SQL, unchanged.
  class CustomError extends Error {
    extra: number;
    constructor(message: string) {
      super(message);
      this.extra = 42;
    }
  }
  const marker = new CustomError("thrown in a function");
  f.function("boom", () => {
    throw marker;
  });
  f.function("boomOn", (a) => {
    if (a === 3) throw new Error(`boom on ${a}`);
    return a ?? null;
  });
  const sameError = (body: () => void): string => {
    try {
      body();
      return "no error";
    } catch (error) {
      const e = error as CustomError;
      return `same object ${error === marker}, extra ${e.extra}, ${showError(error)}`;
    }
  };
  attempt("udf throws, get", () => sameError(() => f.prepare("select boom() x").get()));
  attempt("udf throws, all", () => sameError(() => f.prepare("select boom() x").all()));
  attempt("udf throws, run", () => sameError(() => f.prepare("select boom() x").run()));
  attempt("udf throws, exec", () => sameError(() => f.exec("select 1; select boom(); select 2")));
  attempt("udf throws, in a where clause", () => sameError(() => f.prepare("select x from g where boom() = 1").all()));
  attempt("udf throws, iterate", () => {
    const seen: string[] = [];
    try {
      for (const r of f.prepare("select boomOn(x) v from (select 1 x union all select 2 union all select 3 union all select 4)").iterate())
        seen.push(showRow(r as Record<string, Value>));
    } catch (error) {
      seen.push(showError(error));
    }
    return seen.join(" ");
  });
  attempt("udf throws, value out of range", () => row("select echo(9007199254740993) v"));
  attempt("udf throws, inside a transaction", () => {
    f.exec("create table tx (x); begin; insert into tx values (1)");
    const before = f.isTransaction;
    let message = "";
    try {
      f.exec("insert into tx values (boom())");
    } catch (error) {
      message = (error as Error).message;
    }
    const after = f.isTransaction;
    f.exec("commit");
    return `${before} ${message} ${after} ${rowsOf("select x from tx")}`;
  });
  attempt("udf after exceptions", () => row("select plus(20, 22) r, boomOn(2) b"));

  // A function that runs SQL on its own connection, with another function.
  f.exec("create table kv (k text primary key, v integer); insert into kv values ('a', 1), ('b', 2)");
  const lookup = f.prepare("select plus(v, 100) v from kv where k = ?");
  f.function("lookup", (k) => {
    const found = lookup.all(k ?? null);
    return found.length === 0 ? null : (found[0] as { v: number }).v;
  });
  attempt("udf runs SQL itself", () => row("select lookup('a') a, lookup('b') b, lookup('z') z"));

  // Aggregates.
  f.exec(`
    create table nums (grp text, x integer, y integer);
    insert into nums values ('a', 1, 10), ('a', 2, 20), ('b', 3, 30), ('a', 4, 40), ('b', 5, 50), ('c', 6, null);
  `);
  f.aggregate("sumint", { start: 0, step: (acc, x) => (acc as number) + ((x as number | null) ?? 0) });
  f.aggregate("joined", {
    start: () => "",
    step: (acc, x) => `${acc}${acc === "" ? "" : "+"}${x}`,
    result: (acc) => `[${acc}]`,
  });
  attempt("aggregate", () => row("select sumint(x) s, joined(x) j from nums"));
  attempt("aggregate, group by", () => rowsOf("select grp, sumint(x) s, joined(x) j from nums group by grp order by grp"));
  attempt("aggregate, two at once", () => row("select sumint(x) a, sumint(y) b, joined(y) c from nums"));
  attempt("aggregate, no rows", () => row("select sumint(x) s, joined(x) j from nums where 0"));
  attempt("aggregate, no rows, group by", () => rowsOf("select grp, sumint(x) s from nums where 0 group by grp"));
  attempt("aggregate, wrong argument count", () => row("select sumint(x, y) s from nums"));
  f.aggregate("bigsum", {
    start: 0n,
    useBigIntArguments: true,
    step: (acc, x) => (acc as bigint) + (x as bigint),
  });
  attempt("aggregate, bigint arguments", () => {
    const s = f.prepare("select bigsum(v) s, typeof(bigsum(v)) t from (select 4611686018427387904 v union all select 4611686018427387903)");
    s.setReadBigInts(true);
    return showRow(s.get() as Record<string, Value>);
  });
  f.aggregate("argCount", {
    start: 0,
    varargs: true,
    // A typed accumulator: scriptc cannot pass "(acc, ...rest)" where the
    // untyped step shape is declared, so this takes the second signature.
    step: (acc: number, ...xs: Value[]) => acc + xs.length,
  });
  attempt("aggregate, varargs", () => row("select argCount() a, argCount(x) b, argCount(x, y, grp) c from nums"));
  f.aggregate("seen", { start: () => "", step: (acc) => `${acc}.` });
  attempt("aggregate, step without values", () => row("select seen() s from nums"));

  // A window function: an aggregate with inverse.
  f.aggregate("winsum", {
    start: 0,
    step: (acc, x) => (acc as number) + (x as number),
    inverse: (acc, x) => (acc as number) - (x as number),
    result: (acc) => `=${acc}`,
  });
  attempt("window function", () =>
    rowsOf(`select x, winsum(x) over w s, sum(x) over w builtin from nums
            window w as (order by x rows between 1 preceding and 1 following) order by x`),
  );
  attempt("window function, partitions", () =>
    rowsOf(`select grp, x, winsum(x) over (partition by grp order by x) s from nums order by grp, x`),
  );
  attempt("window function, as a plain aggregate", () => row("select winsum(x) s from nums"));
  attempt("aggregate without inverse, as a window", () =>
    rowsOf("select x, sumint(x) over (order by x rows between 1 preceding and current row) s from nums order by x"),
  );

  // Exceptions in each part of an aggregate. The step case has no result
  // function: with one, Node 24 loses the step's exception and returns no
  // rows (see NOTES.md), where this module throws it.
  const aggThrows = (label: string, part: string) => {
    f.aggregate(`fail_${part}`, {
      start: () => {
        if (part === "start") throw new Error(`${label}: start`);
        return 0;
      },
      step: (acc, x) => {
        if (part === "step" && x === 4) throw new Error(`${label}: step on ${x}`);
        return (acc as number) + (x as number);
      },
      inverse: (acc, x) => {
        if (part === "inverse") throw new Error(`${label}: inverse`);
        return (acc as number) - (x as number);
      },
      result:
        part === "step"
          ? undefined
          : (acc) => {
              if (part === "result") throw new Error(`${label}: result`);
              return acc;
            },
    });
    attempt(`aggregate throws in ${part}`, () => row(`select fail_${part}(x) s from nums`));
    attempt(`aggregate throws in ${part}, window`, () =>
      rowsOf(`select x, fail_${part}(x) over (order by x rows between 1 preceding and current row) s from nums`),
    );
  };
  for (const part of ["start", "step", "inverse", "result"]) aggThrows("agg", part);
  attempt("aggregate after exceptions", () => row("select sumint(x) s from nums"));

  // directOnly aggregates.
  f.aggregate("dsum", { start: 0, directOnly: true, step: (acc, x) => (acc as number) + (x as number) });
  attempt("aggregate directOnly, direct", () => row("select dsum(x) s from nums"));
  attempt("aggregate directOnly, in a view", () => {
    f.exec("create view dv as select dsum(x) s from nums");
    return row("select s from dv");
  });

  // Node's argument checks that typed code can reach.
  attempt("function, not a function", () => {
    f.function("nf", 5);
    return "defined";
  });
  attempt("aggregate, start missing", () => {
    f.aggregate("ns", { start: undefined, step: (acc: unknown) => acc });
    return "defined";
  });
  attempt("aggregate, step not a function", () => {
    f.aggregate("ns", { start: 0, step: "step" });
    return "defined";
  });
  attempt("aggregate, inverse not a function", () => {
    f.aggregate("ns", { start: 0, step: (acc: unknown) => acc, inverse: 1 });
    return "defined";
  });

  f.close();
  attempt("function on a closed database", () => {
    f.function("late", () => 1);
    return "defined";
  });
  attempt("aggregate on a closed database", () => {
    f.aggregate("late", { start: 0, step: (acc) => acc });
    return "defined";
  });
}

// ── day 4: location, serialize, deserialize, backup ─────────────────────
// Serialized bytes carry the SQLite version that wrote them, and Node's
// SQLite is not ours, so the test prints what the bytes do, not the bytes.
{
  mkdirSync("build/tmp", { recursive: true });
  const file = "build/tmp/day4.db";
  const copy = "build/tmp/day4-copy.db";
  for (const f of [file, copy]) rmSync(f, { force: true });
  const disk = new DatabaseSync(file);
  disk.exec(`
    create table t (id integer primary key, body text, data blob);
    with recursive n(i) as (select 1 union all select i + 1 from n where i < 400)
    insert into t (body, data) select 'row ' || i || ' ✓', zeroblob(i % 50) from n;
  `);
  const mem = new DatabaseSync(":memory:");
  attempt("location of a file", () => {
    const where = disk.location();
    return where === null ? "null" : where.endsWith("build/tmp/day4.db") ? "ends with build/tmp/day4.db" : where;
  });
  attempt("location of :memory:", () => JSON.stringify(mem.location()));
  attempt("location of temp", () => JSON.stringify(disk.location("temp")));
  attempt("location of an unknown schema", () => JSON.stringify(disk.location("nope")));

  const summary = (d: DatabaseSync): string =>
    showRow(d.prepare("select count(*) n, sum(length(body)) chars, sum(length(data)) bytes from t").get() as Record<string, Value>);
  let bytes: Uint8Array = new Uint8Array(0);
  attempt("serialize", () => {
    bytes = disk.serialize();
    const header = new TextDecoder().decode(bytes.subarray(0, 15));
    return `${JSON.stringify(header)}, whole pages ${bytes.length > 0 && bytes.length % 4096 === 0}`;
  });
  attempt("serialize an empty memory database", () => `length ${mem.serialize().length}`);
  attempt("deserialize into :memory:", () => {
    const before = mem.prepare("select 1 one");
    mem.deserialize(bytes);
    let old = "";
    try {
      before.get();
      old = "still usable";
    } catch (error) {
      old = showError(error);
    }
    return `${summary(mem)} | earlier statement: ${old} | location ${JSON.stringify(mem.location())}`;
  });
  attempt("deserialized copy is separate", () => {
    mem.exec("delete from t where id > 10");
    return `${summary(mem)} | file still ${summary(disk)}`;
  });
  attempt("deserialize empty", () => {
    mem.deserialize(new Uint8Array(0));
    return "done";
  });
  attempt("deserialize garbage, then query", () => {
    mem.deserialize(new TextEncoder().encode("not a database at all, just text that is long enough"));
    return summary(mem);
  });
  attempt("deserialize inside a function", () => {
    const d = new DatabaseSync(":memory:");
    d.function("swap", () => {
      d.deserialize(bytes);
      return 1;
    });
    try {
      return showRow(d.prepare("select swap() s").get() as Record<string, Value>);
    } finally {
      d.close();
    }
  });
  attempt("serialize after close", () => {
    const d = new DatabaseSync(":memory:");
    d.close();
    return `length ${d.serialize().length}`;
  });

  const backupAttempt = async (label: string, body: () => Promise<string>): Promise<void> => {
    try {
      console.log(`${label}: ${await body()}`);
    } catch (error) {
      console.log(`${label}: ${showError(error)}`);
    }
  };
  await backupAttempt("backup", async () => {
    const pages = await backup(disk, copy);
    const b = new DatabaseSync(copy, { readOnly: true });
    try {
      return `pages > 0 ${pages > 0} | copy ${summary(b)}`;
    } finally {
      b.close();
    }
  });
  await backupAttempt("backup, one page per round", async () => {
    const seen: number[] = [];
    const totals: number[] = [];
    const pages = await backup(disk, copy, {
      rate: 1,
      progress: (p) => {
        seen.push(p.remainingPages);
        totals.push(p.totalPages);
      },
    });
    if (totals.some((t) => t !== pages)) seen.push(-1);
    let falling = true;
    for (let i = 1; i < seen.length; i++) if (seen[i]! >= seen[i - 1]!) falling = false;
    return `rounds ${seen.length === pages - 1 ? "pages - 1" : String(seen.length)}, remaining falls by one ${falling}, first ${seen[0] === pages - 1}`;
  });
  await backupAttempt("backup, rate 0", async () => String(await backup(disk, copy, { rate: 0 })));
  await backupAttempt("backup, rate 1.5", async () => String(await backup(disk, copy, { rate: 1.5 })));
  await backupAttempt("backup, unknown source schema", async () => String(await backup(disk, copy, { source: "nope" })));
  await backupAttempt("backup, progress throws", async () =>
    String(
      await backup(disk, copy, {
        rate: 1,
        progress: () => {
          throw new Error("stop the backup");
        },
      }),
    ),
  );
  await backupAttempt("backup into a directory that does not exist", async () =>
    String(await backup(disk, "build/tmp/no/such/dir/x.db")),
  );
  await backupAttempt("backup of a closed database", async () => {
    const d = new DatabaseSync(":memory:");
    d.close();
    return String(await backup(d, copy));
  });
  disk.close();
  mem.close();
  for (const f of [file, copy]) rmSync(f, { force: true });
}

// A statement used before and after its table gains a column (found by the
// migration test: column names were read before SQLite recompiled it).
{
  const d = new DatabaseSync(":memory:");
  d.exec("create table g (a integer); insert into g values (1)");
  const star = d.prepare("select * from g");
  attempt("select * before alter", () => showRow(star.get() as Record<string, Value>));
  d.exec("alter table g add column b text not null default 'new'");
  attempt("select * after alter, get", () => showRow(star.get() as Record<string, Value>));
  attempt("select * after alter, all", () => (star.all() as Record<string, Value>[]).map((r) => showRow(r)).join(" "));
  attempt("select * after alter, iterate", () => {
    const out: string[] = [];
    for (const r of star.iterate()) out.push(showRow(r as Record<string, Value>));
    return out.join(" ");
  });
  attempt("columns() after alter", () => star.columns().map((c) => c.name).join(", "));
  d.close();
}

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
