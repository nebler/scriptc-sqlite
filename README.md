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

## Install

scriptc compiles TypeScript packages only when they are linked into a project, not when they are copied into `node_modules`. So add this package from a checkout:

```json
"dependencies": { "scriptc-sqlite": "file:../path/to/sqlite" }
```

A workspace package (npm, pnpm or yarn workspaces) works too. You also need scriptc 0.4.12 or later and what scriptc needs to link: clang on Linux, Xcode's command-line tools on macOS. Building SQLite also needs `sh`, `unzip` and `curl`.

## Your own native code

If your program has its own FFI manifest, pass it as usual. `scriptc-sqlite` merges it with SQLite's, because scriptc takes one manifest per build:

```console
$ scriptc-sqlite build app.ts --ffi native/ffi.json -o app
```

To run scriptc yourself, `scriptc-sqlite manifest [--sanitize] [--ffi yours.json]` prints the path of the merged manifest to pass to `--ffi`.

## What it covers

It follows Node 24's `node:sqlite`:

- **`DatabaseSync`:** `open`, `close`, `exec`, `prepare`, `isOpen`, `isTransaction` and `Symbol.dispose`. Options: `open`, `readOnly`, `timeout`, `readBigInts`, `enableForeignKeyConstraints`, `enableDoubleQuotedStringLiterals`, `allowBareNamedParameters` and `allowUnknownNamedParameters`.
- **`StatementSync`:** `run`, `get`, `all`, `iterate`, `columns`, `sourceSQL`, `expandedSQL`, `setReadBigInts`, `setAllowBareNamedParameters`, `setAllowUnknownNamedParameters`, `close` and `Symbol.dispose`.

Values, errors and their codes are the same as Node's.

Not covered:

- **Rows as arrays (`returnArrays`):** rows are always objects, see `NOTES.md`.
- **User-defined SQL functions and aggregates.**
- **Sessions, backups, `serialize` and `loadExtension`.**

For the reasons, and for how this was checked against Node, see `NOTES.md`.

Read a row by casting it to a `type`, as above. TypeScript refuses the same cast to an `interface`.
