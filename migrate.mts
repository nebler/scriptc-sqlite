// Migrations (src/migrate.ts), run unchanged under Node (on node:sqlite)
// and as a scriptc binary; run.sh compares the two outputs byte for byte.
import { DatabaseSync } from "#sqlite";
import { MigrationError, migrate, pendingMigrations, type Migration } from "./src/migrate.ts";
import { mkdirSync, rmSync } from "node:fs";

function attempt(label: string, body: () => string): void {
  try {
    console.log(`${label}: ${body()}`);
  } catch (error) {
    if (error instanceof MigrationError) {
      const inner = error.error as { message: string; code?: string };
      console.log(`${label}: MigrationError ${JSON.stringify(error.migration)}: ${JSON.stringify(error.message)} (${inner.code ?? "no code"})`);
    } else console.log(`${label}: error ${JSON.stringify((error as Error).message)}`);
  }
}

mkdirSync("build/tmp", { recursive: true });
const path = "build/tmp/migrate.db";
for (const s of ["", "-wal", "-shm"]) rmSync(path + s, { force: true });

const v1: Migration[] = [
  { name: "create notes", sql: "create table notes (id integer primary key, body text not null)" },
  {
    name: "seed",
    sql: "insert into notes (body) values ('first'); insert into notes (body) values ('second ✓');",
  },
  {
    name: "uppercase bodies",
    run: (db) => {
      const rows = db.prepare("select id, body from notes").all() as { id: number; body: string }[];
      const update = db.prepare("update notes set body = ? where id = ?");
      for (const r of rows) update.run(r.body.toUpperCase(), r.id);
    },
  },
];
const v2: Migration[] = [
  ...v1,
  { name: "add tags", sql: "alter table notes add column tags text not null default ''" },
  { name: "wal", sql: "pragma journal_mode = wal", transaction: false },
];

const notes = (db: DatabaseSync): string =>
  (db.prepare("select * from notes order by id").all() as Record<string, unknown>[])
    .map((r) => Object.keys(r).map((k) => `${k}=${JSON.stringify(r[k])}`).join(" "))
    .join(" | ");

let db = new DatabaseSync(path);
attempt("pending on a new database", () => pendingMigrations(db, v1).join(", "));
attempt("first run", () => JSON.stringify(migrate(db, v1)));
attempt("notes", () => notes(db));
attempt("run again", () => JSON.stringify(migrate(db, v1)));
attempt("pending for v2", () => pendingMigrations(db, v2).join(", "));
attempt("upgrade to v2", () => JSON.stringify(migrate(db, v2)));
attempt("notes after v2", () => notes(db));
attempt("journal mode", () => JSON.stringify(db.prepare("pragma journal_mode").get()));
attempt("recorded", () =>
  (db.prepare("select id, name, checksum, length(applied_at) n from _migrations order by id").all() as Record<string, unknown>[])
    .map((r) => `${r["id"]} ${r["name"]} ${r["checksum"]} ${r["n"]}`)
    .join(" | "),
);

// What it refuses.
attempt("an older program", () => JSON.stringify(migrate(db, v1)));
attempt("an edited migration", () =>
  JSON.stringify(migrate(db, [v2[0]!, { name: "seed", sql: "insert into notes (body) values ('changed')" }, ...v2.slice(2)])),
);
attempt("a renamed migration", () => JSON.stringify(migrate(db, [{ ...v2[0]!, name: "make notes" }, ...v2.slice(1)])));
attempt("two with one name", () => JSON.stringify(migrate(db, [...v2, { name: "seed", sql: "select 1" }])));
attempt("neither sql nor run", () => JSON.stringify(migrate(db, [...v2, { name: "empty" }])));
attempt("both sql and run", () => JSON.stringify(migrate(db, [...v2, { name: "both", sql: "select 1", run: () => {} }])));

// A failing change is rolled back; the ones before it stay.
const v3: Migration[] = [
  ...v2,
  { name: "add archive", sql: "create table archive (id integer primary key)" },
  { name: "broken", sql: "create table half (x); insert into nowhere values (1);" },
  { name: "never reached", sql: "create table never (x)" },
];
attempt("a failing migration", () => JSON.stringify(migrate(db, v3)));
attempt("after the failure", () =>
  (db.prepare("select name from sqlite_schema where type = 'table' order by name").all() as { name: string }[])
    .map((r) => r.name)
    .join(", "),
);
attempt("pending after the failure", () => pendingMigrations(db, v3).join(", "));
attempt("in a transaction after the failure", () => String(db.isTransaction));
attempt("code that throws", () =>
  JSON.stringify(
    migrate(db, [
      ...v2,
      { name: "add archive", sql: "create table archive (id integer primary key)" },
      {
        name: "thrower",
        run: (d) => {
          d.exec("insert into notes (body) values ('should vanish')");
          throw new Error("no thanks");
        },
      },
    ]),
  ),
);
attempt("notes after the thrower", () => notes(db));
db.close();

// Reopened, the database remembers.
db = new DatabaseSync(path);
attempt("reopened, pending", () => pendingMigrations(db, v3.slice(0, 6)).join(", ") || "(none)");
db.close();
for (const s of ["", "-wal", "-shm"]) rmSync(path + s, { force: true });
console.log("done");
