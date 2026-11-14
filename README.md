# scriptc-sqlite

`node:sqlite` for programs compiled with [scriptc](https://scriptc.dev). SQLite is compiled into the program, so the executable needs no SQLite on the machine it runs on.

```ts
import { DatabaseSync } from "scriptc-sqlite";

type Note = { id: number; body: string };

const db = new DatabaseSync(":memory:");
db.exec("create table if not exists notes (id integer primary key, body text)");
db.prepare("insert into notes (body) values (?)").run("hello 🙂");
for (const row of db.prepare("select id, body from notes").iterate()) {
  const note = row as Note;
  console.log(note.id, note.body);
}
db.close();
```

Build with `scriptc-sqlite` instead of `scriptc`. It takes the same commands and options:

```console
$ scriptc-sqlite build app.ts -o app
$ ./app
1 hello 🙂
```

The first build compiles SQLite once, which takes about a minute.

Also here:
- **`scriptc-sqlite/query`:** a typed query builder that compiles natively (Kysely and Drizzle don't, yet).
- **`scriptc-sqlite/migrate`:** schema migrations.
- **`demo/`:** `marks`, a bookmarks tool in one 3 MB executable.
- **`template/`:** a starter project.
- **`bench/`:** benchmarks against Node, Deno, Bun, Go and Rust.

## Install

scriptc compiles TypeScript packages only when they are linked into a project, not when they are copied into `node_modules`. So add this package from a checkout:

```json
"dependencies": { "scriptc-sqlite": "file:../path/to/sqlite" }
```

A workspace package (npm, pnpm or yarn workspaces) works too. Or start from the starter project, which sets this up for you:

```console
$ npx degit nebler/scriptc-sqlite/template my-app
$ cd my-app && node setup.mjs && npm run build && ./build/app list
```

 You also need scriptc 0.4.12 or later and what scriptc needs to link: clang on Linux, Xcode's command-line tools on macOS. Building SQLite also needs `sh`, `unzip` and `curl`.

## Your own native code

If your program has its own FFI manifest, pass it as usual. `scriptc-sqlite` merges it with SQLite's, because scriptc takes one manifest per build:

```console
$ scriptc-sqlite build app.ts --ffi native/ffi.json -o app
```

To run scriptc yourself, `scriptc-sqlite manifest [--sanitize] [--ffi yours.json]` prints the path of the merged manifest to pass to `--ffi`.

## What it covers

It follows Node 24's `node:sqlite`:

- **`DatabaseSync`:** `open`, `close`, `exec`, `prepare`, `function`, `aggregate` (window functions too), `location`, `serialize`, `deserialize`, `isOpen`, `isTransaction` and `Symbol.dispose`. Options: `open`, `readOnly`, `timeout`, `readBigInts`, `enableForeignKeyConstraints`, `enableDoubleQuotedStringLiterals`, `allowBareNamedParameters` and `allowUnknownNamedParameters`.
- **`StatementSync`:** `run`, `get`, `all`, `iterate`, `columns`, `sourceSQL`, `expandedSQL`, `setReadBigInts`, `setAllowBareNamedParameters`, `setAllowUnknownNamedParameters`, `close` and `Symbol.dispose`.

- **`backup(db, path, options)`:** an online copy into a file, with `rate`, `source`, `target` and `progress`. Node runs it on its thread pool; here each round runs on the program's thread, and other work runs between rounds.

Values, errors and their codes are the same as Node's.

Not covered:

- **Rows as arrays (`returnArrays`):** rows are always objects, see `NOTES.md`.
- **Sessions and changesets, `loadExtension`, `createTagStore`, `setAuthorizer`, `limits` and `enableDefensive`.**

For the reasons, and for how this was checked against Node, see `NOTES.md`.

Read a row by casting it to a `type`, as above. TypeScript refuses the same cast to an `interface`.

## Fast typed reads

Two methods that `node:sqlite` doesn't have read rows without building a row object:

```ts
type Note = { id: number; title: string; tag: string | null };

const notes = db.prepare("select id, title, tag from notes where id > ?").map(
  (row): Note => ({ id: row.number(0), title: row.text(1), tag: row.isNull(2) ? null : row.text(2) }),
  10,
);

let words = 0;
db.prepare("select body from notes").forEach((row) => {
  words += row.text(0).split(" ").length;
});
```

- **`map(read, ...params)`** returns `read(row)` for each row; **`forEach(fn, ...params)`** only calls `fn(row)`. Parameters work as for `all()`.
- **The row** reads a column by index: `number(i)` (INTEGER or REAL), `text(i)`, `textBytes(i)` (a TEXT column's UTF-8 bytes, copied, without making a string), `blob(i)`, `isNull(i)`, `value(i)` (as `all()` would give it), and `length`. A column of another type throws `ERR_SQLITE_COLUMN_TYPE`; nothing is converted silently. Integers beyond ±(2^53 − 1) throw `ERR_OUT_OF_RANGE`, as in Node. The row is only valid inside the callback.
- **Why it's faster:** `all()` and `iterate()` build a dynamic object per row, and `row as Note` then makes scriptc check every field at run time. Here the callback returns an object literal of a declared type, which scriptc builds natively. Reading a million rows takes about a third of the time of `iterate()` (the benchmark's "typed reads" row).
- **Under Node:** this repository's test programs import `#sqlite`, which under Node is `node:sqlite` with these two methods added (`src/node-sqlite.ts`), so the same program runs in both. `typed.mts` checks that the two agree byte for byte.

## Fast writes and number functions

Two more methods for hot paths, also not in `node:sqlite`:

```ts
const add = db.prepare("insert into points (x, y, label) values (?, ?, ?)");
db.exec("begin");
const changes = add.runMany(points.length, (i, p) => {
  p.number(0, points[i].x);
  p.number(1, points[i].y);
  p.text(2, points[i].label);
});
db.exec("commit");

db.numberFunction("hypot", (a, b) => Math.sqrt(a * a + b * b), { deterministic: true });
```

- **`stmt.runMany(count, bind)`** runs the statement `count` times. Before each run, `bind(i, p)` sets its values by position, as `run(a, b, …)` would: `p.number(0, a)`, `p.text(1, b)`, and `p.blob`, `p.bigint` and `p.null`. Values a run doesn't set are NULL, rows a statement returns are ignored, and it returns the total of the runs' changes. If a run fails, it throws, and the runs before it stay done (inside your transaction). It's about a third faster than calling `run()` in a loop, because the per-call work happens once.
- **`db.numberFunction(name, fn, options?)`** registers a SQL function of up to four numbers that returns a number. Its parameters are numbers, not `SQLOutputValue`s, so scriptc calls it directly: almost twice as fast as the same `db.function`. An argument that isn't a number is an SQL error (`ERR_INVALID_ARG_TYPE`), integers beyond ±(2^53 − 1) throw `ERR_OUT_OF_RANGE`, and a NaN result is NULL. Options: `deterministic`, `directOnly`.
- **Under Node** both are added the same way as `map` and `forEach`, and `typed.mts` checks them against Node byte for byte.

## SQL functions

```ts
db.function("slugify", { deterministic: true }, (title) => String(title).toLowerCase().replaceAll(" ", "-"));
db.aggregate("product", { start: 1, step: (acc, x) => (acc as number) * (x as number) });
db.prepare("select slugify(title) slug from notes").all();
```

Write functions without parameter types, as above: each parameter is then a SQL value or `undefined`, and SQL must call the function with as many arguments as it declares, as in Node. Functions with typed parameters or a rest parameter work too:

- `(...values: SQLOutputValue[]) => …` with `{ varargs: true }`.
- For an aggregate step with a rest parameter, type the accumulator: `(acc: number, ...values: SQLOutputValue[]) => …`. With `acc: unknown`, scriptc refuses it (SC1090).

The reason is a scriptc limit; see `NOTES.md`. An exception thrown in a function comes out of the `run`, `get`, `all`, `iterate` or `exec` call that ran the SQL, unchanged.

## Typed queries

Kysely and Drizzle don't compile with scriptc yet, so this package has a small typed query builder that does (it also runs under Node, on `node:sqlite`):

```ts
import { QueryBuilder, gt, integer, same, table, text } from "scriptc-sqlite/query";

const person = table("person", { id: integer(), name: text(), age: integer() });
const pet = table("pet", { id: integer(), ownerId: integer("owner_id"), species: text() });

const q = new QueryBuilder(db);
const ada = q.insertInto(person, { name: "Ada", age: 36 }).run().lastInsertRowid;
q.insertInto(pet, { ownerId: ada, species: "cat" }, { ownerId: ada, species: "owl" }).run();

const rows = q
  .select({ owner: person.c.name, pet: pet.c.species })
  .from(person)
  .innerJoin(pet, same(pet.c.ownerId, "=", person.c.id))
  .where(gt(person.c.age, 30))
  .all(); // { owner: string; pet: string }[]
```

- **Tables** are declared in TypeScript: `integer()`, `real()`, `text()`, `blob()`, `nullable(…)`, with `.primaryKey()`, `.unique()`, `.references(other.c.id)` and `.defaultTo(value)`. A column takes its key as its SQL name unless you give one (`integer("owner_id")`). `q.createTable(t)` writes the `create table`: NOT NULL unless `nullable()`. `createIndex` and `dropTable` are there too.
- **The same table twice** (a self-join): declare it again with fresh columns and an alias, `table("employee", employeeColumns(), "manager")`.
- **Selecting:** `select({ alias: expression })` or `selectAll(table)`, then `from`, `innerJoin`, `leftJoin`, `where`, `groupBy`, `having`, `orderBy`, `limit`, `offset`, `distinct`. Finish with `all()` or `first()`. Wrap a left-joined table's columns in `orNull()`, so their type allows NULL.
- **Writing:** `insertInto(table, row, …)`, `update(table, values).where(…)` and `deleteFrom(table).where(…)`. Finish with `run()`, or `returning({ … }).all()`. Without `where`, update and delete touch every row. Upserts: `insertInto(…).onConflictDoNothing(cols…)` or `.onConflictDoUpdate([conflict cols], [cols to update])`.
- **Conditions:** `eq`, `ne`, `lt`, `le`, `gt`, `ge`, `same` (two expressions), `and`, `or`, `not`, `inList`, `isNull`, `isNotNull`, `like`, `between`.
- **Subqueries:** `inSelect(column, select)`, `exists(select)` and `scalar(select)` (a one-column subquery as a value), correlated through column references.
- **Expressions:** `count`, `sum`, `avg`, `min`, `max`, and `raw<T>("sql", [params])` with a declared type, for anything else, including your own SQL functions.
- **Transactions:** `q.transaction(() => …)` commits when the body returns and rolls back when it throws. Nested calls use savepoints.
- **Values are always bound as parameters.** Only names you wrote and text you give `raw` go into the SQL.
- **The compiler checks** that values match their columns, that columns exist, and that rows are read with the types and columns you selected.
- **Not there yet:** typed results for left joins without `orNull`, window functions in the builder (use `raw`), compound selects (`union`), and `create table` constraints beyond the column methods above.
- **One scriptc 0.4.12 bug to know:** if a `transaction` body always throws, write it as `(): void => { … }`. Otherwise scriptc miscompiles the program's other `transaction` calls.

## Migrations

```ts
import { migrate } from "scriptc-sqlite/migrate";

migrate(db, [
  { name: "create notes", sql: "create table notes (id integer primary key, body text not null)" },
  { name: "add tags", sql: "alter table notes add column tags text not null default ''" },
  { name: "fill tags", run: (db) => { /* code, for changes SQL alone can't make */ } },
]);
```

- **Behavior:** `migrate` applies the changes this database hasn't had, in order, each in its own transaction, and records them in a `_migrations` table. A change that fails is rolled back and thrown as a `MigrationError`; the ones before it stay. `pendingMigrations(db, list)` says what would run.
- **Rules:** add new changes at the end and never edit, rename or reorder applied ones. `migrate` refuses such a list, with a message naming the change. It also refuses a database that has changes the program doesn't know (a newer program wrote it).
- **Statements SQLite refuses inside a transaction** (`vacuum`, `pragma journal_mode`): mark that change `transaction: false`.

## The demo: `marks`

`demo/` is a bookmarks tool built as its own project, using everything above: migrations, the query builder, full-text search (FTS5), a user SQL function, upserts and online backups. It builds to one 3 MB executable (stripped) that links only the C library.

```console
$ cd demo && npm ci && npm run build
$ ./build/marks add https://sqlite.org/fts5.html "SQLite FTS5 Extension" --tag sqlite
$ ./build/marks find sqlite
```

`demo/session.expected` is a full session `run.sh` checks. The "Demo binaries" workflow (manual, in GitHub Actions) builds it for Linux x64, Linux arm64 and macOS arm64 and attaches the binaries to the run.

## Benchmarks

`bench/` runs the same workloads with this package, Node, Deno, Bun, Go and Rust: start-up, bulk insert, reading rows, long text and blobs, and user functions. It measures time, peak memory and size. See `bench/README.md`. The "Benchmarks" workflow (manual) runs it on GitHub's Linux x64, Linux arm64 and macOS machines and posts the tables.
