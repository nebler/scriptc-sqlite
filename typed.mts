// Typed row reads: StatementSync.map() and forEach() with the column
// reader. Run under Node (src/node-sqlite.ts adds the same methods to
// node:sqlite) and compiled; run.sh compares the two outputs byte for byte.
import { DatabaseSync } from "#sqlite";
import type { Columns } from "#sqlite";

function showError(error: unknown): string {
  const e = error as { message: string; code?: string };
  return `error code ${e.code}, message ${JSON.stringify(e.message)}`;
}

function attempt(label: string, body: () => string): void {
  try {
    console.log(`${label}: ${body()}`);
  } catch (error) {
    console.log(`${label}: ${showError(error)}`);
  }
}

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

const db = new DatabaseSync(":memory:");
db.exec(`
  create table t (id integer primary key, n integer, r real, body text, data blob, maybe text);
  insert into t (n, r, body, data, maybe) values
    (1, 0.5, 'one ✓', x'0102', null),
    (-2, 1.25, 'ünïcødé 🙂', x'', 'here'),
    (9007199254740991, -0.0, '', x'ff00ff', null);
  create table big (v integer);
  insert into big values (9007199254740992), (-9007199254740993);
`);

type Item = { id: number; n: number; r: number; body: string; size: number; maybe: string | null };

const items = db
  .prepare("select id, n, r, body, data, maybe from t order by id")
  .map(
    (c): Item => ({
      id: c.number(0),
      n: c.number(1),
      r: c.number(2),
      body: c.text(3),
      size: c.blob(4).length,
      maybe: c.isNull(5) ? null : c.text(5),
    }),
  );
for (const it of items)
  console.log(`map: ${it.id} ${it.n} ${Object.is(it.r, -0) ? "-0" : it.r} ${JSON.stringify(it.body)} ${it.size} ${it.maybe}`);

let total = 0;
let chars = 0;
db.prepare("select n, body from t where id >= ?").forEach((c) => {
  total += c.number(0);
  chars += c.text(1).length;
}, 2);
console.log(`forEach with a parameter: ${total} ${chars}`);

const named = db.prepare("select body from t where id = $id").map((c) => c.text(0), { $id: 1 });
console.log(`named parameter: ${JSON.stringify(named)}`);

const empty = db.prepare("select n from t where id > 100").map((c) => c.number(0));
console.log(`no rows: ${empty.length}`);

console.log(`length: ${db.prepare("select 1, 2, 3").map((c) => c.length).join(",")}`);

attempt("blobs", () => db.prepare("select data from t order by id").map((c) => hex(c.blob(0))).join(" "));

attempt("value()", () =>
  db
    .prepare("select n, r, body, maybe from t where id = 1")
    .map((c) => [c.value(0), c.value(1), c.value(2), c.value(3)].map((v) => String(v)).join("|"))
    .join(""),
);

const bigs = db.prepare("select v from big where v > 0");
bigs.setReadBigInts(true);
attempt("value() with readBigInts", () => bigs.map((c) => `${typeof c.value(0)} ${String(c.value(0))}`).join(""));
attempt("number() beyond 2^53", () => String(db.prepare("select v from big where v > 0").map((c) => c.number(0))));
// Not -2^63: Node on Linux rounds it instead of refusing it (see test.mts).
attempt("number() below -(2^53 - 1)", () => String(db.prepare("select v from big where v < 0").map((c) => c.number(0))));

attempt("text() of a number", () => db.prepare("select n from t").map((c) => c.text(0)).join());
attempt("number() of text", () => String(db.prepare("select body from t").map((c) => c.number(0))));
attempt("number() of null", () => String(db.prepare("select maybe from t").map((c) => c.number(0))));
attempt("blob() of text", () => String(db.prepare("select body from t").map((c) => c.blob(0).length)));
attempt("text() of a blob", () => db.prepare("select data from t").map((c) => c.text(0)).join());
attempt("index past the end", () => String(db.prepare("select 1").map((c) => c.number(1))));
attempt("negative index", () => String(db.prepare("select 1").map((c) => c.number(-1))));
attempt("fractional index", () => String(db.prepare("select 1").map((c) => c.number(0.5))));

let kept: Columns | null = null;
db.prepare("select 1").forEach((c) => {
  kept = c;
});
attempt("reading the row after the call", () => String((kept as unknown as Columns).number(0)));

attempt("exception inside the callback", () => {
  db.prepare("select n from t").forEach((c) => {
    if (c.number(0) < 0) throw new Error("negative");
  });
  return "no exception";
});
attempt("statement still usable after that", () => String(db.prepare("select n from t").map((c) => c.number(0))));

attempt("a query inside the callback", () =>
  db
    .prepare("select id from t order by id")
    .map((c) => {
      const id = c.number(0);
      const body = db.prepare("select body from t where id = ?").map((d) => d.text(0), id);
      return `${id}:${body.join("")}`;
    })
    .join(" "),
);

attempt("the same statement inside its own callback", () => {
  const stmt = db.prepare("select id from t order by id");
  return stmt
    .map((c) => `${c.number(0)}/${stmt.map((d) => d.number(0)).length}`)
    .join(" ");
});

attempt("a failing statement", () => String(db.prepare("select abs(-9223372036854775808)").map((c) => c.number(0))));

const inserted = db.prepare("insert into t (n, body) values (?, ?) returning id, body").map(
  (c) => `${c.number(0)} ${c.text(1)}`,
  7,
  "seven",
);
console.log(`returning: ${inserted.join("")}`);

db.close();
attempt("after close", () => String(db.prepare("select 1").map((c) => c.number(0))));
console.log("done");
