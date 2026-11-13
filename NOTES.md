# SQLite for stock scriptc: notes

Uses the published `scriptc@0.4.12` from npm. Days 1 and 2 were built and checked in a Linux arm64 sandbox (gVisor); macOS arm64 was checked afterwards.

## Day 2, 13 November 2026: result

**Done: packaging, the missing everyday pieces, and worker threads.** Every comparison with Node is byte for byte identical, in the release and the sanitized lane, with no sanitizer reports.

| Program | What it checks | Release vs Node | Sanitized vs Node | Peak memory, scriptc vs Node |
|---|---|---|---|---|
| `test.mts` (114 lines of output) | day 1's cases plus iterate, columns, expandedSQL, statement close and `using`, options, named-parameter settings | identical | identical | 114 vs 174 MiB |
| `threads.mts` | 2 writers and 2 readers, each thread with its own connection to one WAL file | identical | identical | 147 vs 272 MiB |
| `small.mts` | an ordinary small program | identical | — | 37 vs 145 MiB |
| `pool.mts` (scriptc only) | 200,000 `prepare` calls over 1,000 distinct SQL texts, none closed | — | — | 45 MiB; at most 64 SQLite statements at any time, no leak in the sanitized lane |
| `example/` | a separate project that installs the package and builds with `scriptc-sqlite`, with its own C function | builds and runs | — | — |

**Size and libraries:** the test binary is 2.8 MB (2.5 MB stripped) and the example app 2.4 MB. Both link only libc and libm.

**Re-run:** after the last full run of `run.sh`, I fixed the README example (see 3 under "What changed"), then rebuilt and ran that one program, not the whole check.

### What changed

1. **Packaging (`bin/scriptc-sqlite.mjs`).** The command takes the same arguments as scriptc: `scriptc-sqlite build app.ts -o app`.
   - On first use, and whenever the shim or `build.sh` changes, it compiles SQLite (hash-checked) for the requested lane. The sanitized lane is built only when `--sanitize` is given.
   - It writes a manifest with absolute paths into `build/manifests/`. A project's own `--ffi` manifest is merged in: its functions are added (a clash is an error), its library paths are made absolute and linked first, and its system libraries are added.
   - It then runs the project's scriptc, else the one beside the package, else `scriptc` on PATH. scriptc's installed command is a native executable, not a JavaScript file.
   - `scriptc-sqlite manifest` prints a manifest path, for people who run scriptc themselves.
   - Tested from scratch: with `build/lib` removed, the command rebuilt it, and the shim archive came out byte-identical.
2. **How it installs, and why only this way.** scriptc compiles a TypeScript package only when it is linked into the project: an npm `file:` dependency, a workspace, or a symlink. A package copied into `node_modules` is refused, because scriptc wants JavaScript plus `.d.ts` files there: `SC2013 ... ships no own .d.ts declaration surface`, or `... not part of the compiled module graph`.
   - So **a plain `npm install scriptc-sqlite` from the registry would not work today.** `example/` uses `"scriptc-sqlite": "file:.."`.
   - Two other routes failed: a `node` export condition makes scriptc treat the package as a Node island; and a project `#alias` that points into `node_modules`, or at a bare package name, is refused (SC1010, SC1090).
3. **Everyday pieces:**
   - `iterate()`, including `return()`, `break`, spreading, and Node's "iterator was invalidated" when the statement is called during iteration.
   - `columns()`, which uses SQLite's column metadata, compiled in.
   - `expandedSQL`, re-bound from the last call's values.
   - `StatementSync.close()` and `Symbol.dispose` on statements and databases, so `using` in a block works.
   - Options `timeout` (busy timeout), `enableForeignKeyConstraints`, `enableDoubleQuotedStringLiterals`, `allowBareNamedParameters` and `allowUnknownNamedParameters`, with the per-statement setters and Node's checks of option types.
   - Null-prototype rows, as in Node.
   - The README example is now built and run by `run.sh`. That check caught an error in my first README: scriptc refuses `using` at the top level of a module (SC1090), so the example uses `close()`.
4. **The statement pool.** Node frees a statement nobody uses any more when its garbage collector runs; scriptc has no garbage collector, and its `FinalizationRegistry` never runs callbacks.
   - So a `StatementSync` no longer holds a SQLite statement between calls. Each call borrows a compiled statement from its database's pool by SQL text, then resets it, clears its bindings and gives it back. The pool keeps at most 64 idle statements, dropping the oldest. An iterator holds its statement until it finishes or `return()` is called.
   - `prepare()` still compiles at once, so SQL errors appear where Node shows them.
   - **Consequences:**
     - A statement whose table was dropped and whose pooled copy was evicted reports the error on its next call, not at `prepare()`. Node, which holds the statement, also reports it on the call.
     - An iterator a program abandons without `return()` keeps its statement until the database closes.

### Differences from Node found today

- **`returnArrays` is left out.** `setReturnArrays(true)` and the option throw `ERR_METHOD_NOT_IMPLEMENTED`.
  - Rows are typed as records, as in Node's own type definitions, and scriptc refuses to pass an array where a record is declared (SC2003).
  - Typing results as "record or array" would allow both, but then `stmt.get() as { id: number }` stops compiling (SC2003, "union conversion has no unambiguous layout mapping"). Such a union also hit an internal compiler error in 0.4.12 (`SC9001 recordKeyGet receiver: expected record, got union`). The usual cast mattered more.
- **A wrongly typed option** (`{ readOnly: "yes" as unknown as boolean }`) is stopped by scriptc's own run-time type check before the module sees it. scriptc's message replaces Node's `ERR_INVALID_ARG_TYPE`. The case was taken out of the shared test.
- **The iterator has no iterator helpers** (`.map`, `.filter` on Node's iterator objects).
- **Calling the statement while one of its iterators is open** gives Node's "iterator was invalidated" on the iterator's next step, as in Node. Our iterator uses its own SQLite statement, but the check copies Node's rule.

### What users need to know (also in README.md)

- **Read rows by casting to a `type`, not an `interface`:** `row as Note` with `type Note = { … }`. TypeScript refuses the cast from a record to an interface. This is the same under Node's types.
- **`stmt.get() as Shape | undefined` does not compile in scriptc (SC2003); `stmt.get() as Shape` does.** Check for `undefined` before the cast, or use `all()`/`iterate()`.
- **scriptc's own limits the tests ran into:** no dot access on index-signature types (`row.x` on a `Record`, SC1090); no top-level `using`.

### Worker threads

`threads.mts` passes in both lanes:
- Readers never saw half a transaction (the count was always a multiple of 50, and the sum always matched), and the count never went down.
- Both writers' 500 rows arrived, with Unicode labels and blobs intact.

Each thread has its own connection, and the module's buffer and pool are per thread. One connection must not be shared between threads; scriptc's workers could not share one anyway.

Not tested: ThreadSanitizer. The scriptc lane here is AddressSanitizer and LeakSanitizer only.

## Day 1, 13 November 2026: result

**Both roadblocks are cleared, on Linux arm64.** A `node:sqlite`-shaped module (`src/sqlite.ts`, `DatabaseSync` and `StatementSync`) runs on SQLite 3.54.1, compiled into the program. `test.mts` runs unchanged under Node 24.22.1 (with `node:sqlite`) and as a scriptc binary, and the outputs are **byte for byte identical** in both lanes:

| Lane | Exit | Output vs Node | Other stderr | Peak memory |
|---|---|---|---|---|
| Release | 0 | identical (83 lines) | none | 106 MiB |
| Sanitized: scriptc's `--sanitize` with SQLite and the shim also built with AddressSanitizer | 0 | identical | none: no AddressSanitizer or LeakSanitizer report | 237 MiB |
| Node 24.22.1 (`node test.mts`) | 0 | reference | none | 154 MiB |
| `small.mts`, release vs Node: file database, WAL, 1,000 rows in one transaction, read back read-only | 0 | identical | none | **33 MiB vs 148 MiB** |

- `test.mts` holds a 1 MiB blob and strings of 300,000 characters in memory at once, so its memory figure is mostly the test's own data. `small.mts` is the fairer figure for an ordinary program.
- **Positive control:** a copy of the shim that writes one byte past the caller's buffer was built into the sanitized lane. AddressSanitizer stopped it at the first blob read with a heap-buffer-overflow in `sqx_column_blob`. So the lane does see the C side (`build/control/`, not part of `run.sh`).
- **Binary size:** release test binary 2.54 MB, 2.29 MB stripped; the SQLite archive is 2.2 MB of that. It links only `libc.so.6` and `libm.so.6`: no system SQLite. The sanitized binary is 23 MB.
- **No timings:** the sandbox's timings are not results.

**What the test covers:**
- Integers, floats, text, blobs and NULL in one table, each with `typeof()` and `length()`.
- Unicode: accents, CJK, emoji with skin tones and ZWJ sequences, combining marks.
- Empty strings and empty blobs (bound as empty, not NULL), embedded NUL bytes in text and blobs, all 256 byte values.
- A 1 MiB blob and a 288,890-byte string, which exercise the buffer growing.
- `NaN` (stored as NULL), ±Infinity, -0.
- 64-bit integers: 2^63-1, -2^63 and 2^53+1, read as numbers (Node's `ERR_OUT_OF_RANGE`) and as bigints (`setReadBigInts`, and the `readBigInts` option); binding out of range (`ERR_INVALID_ARG_VALUE`).
- Positional, named (`$ : @`), mixed and numbered (`?1`) parameters; unbound parameters; too many values; `undefined`; unknown names; booleans.
- Duplicate and expression column names; no row and no rows; statement reuse; `sourceSQL`; multi-statement `exec`; JSON and math functions.
- Errors with Node's `code` and SQLite's extended `errcode` and `errstr`: syntax error (in `prepare` and in the tail of `exec`), no such table, UNIQUE, NOT NULL, CHECK, FOREIGN KEY (on by default, as in Node), double-quoted string literal (off, as in Node), empty statement, bad path, a statement reused after an error.
- Transactions: commit, rollback after a CHECK failure, explicit rollback, nested `begin`, savepoints, `commit` with none active, `isTransaction`.
- Use after close, closing twice, `open: false` then `open()`.

## Differences from Node

**None in the test's output.** Matching took four changes:
1. Errors that are not SQLite's carry no `errcode`/`errstr`.
2. A finalized statement reports "statement has been finalized" before "database is not open".
3. Copied from Node as is: an empty statement is `ERR_INVALID_ARG_VALUE` "The SQL query contains no statements."
4. Copied from Node as is: integers below `Number.MIN_SAFE_INTEGER` come back rounded rather than refused. Node 24 only checks the upper end; -2^63 reads as -9223372036854776000.

**Not the same as Node, outside what the test prints:**
- **Row prototype.** Node returns rows with a null prototype; ours are plain objects, so `row.toString` exists. The test prints rows through its own formatter, so it does not see this.
- **Missing pieces of the API:**
  - `iterate()`, `expandedSQL`, `columns()`, `setReturnArrays`, `setAllowBareNamedParameters`, `setAllowUnknownNamedParameters`.
  - User functions and aggregates (`function`, `aggregate`): these need FFI callbacks.
  - `backup`, sessions and changesets, `serialize`/`deserialize`, `loadExtension` (deliberately compiled out), `location()`, `createTagStore`, `Symbol.dispose`.
  - The `timeout`, `enableForeignKeyConstraints`, `enableDoubleQuotedStringLiterals` and `defensive` options: the first is ignored, the others are fixed at Node's defaults.
- **Statements are finalized only by `db.close()`.** Nothing else frees one, so a program that prepares new statements in a loop without closing the database holds every one of them. Node frees them when they are garbage-collected. Day 2 should add `finalize()`, and maybe a cache keyed by SQL text.
- **Threads:** SQLite is built thread-safe and the shim keeps no shared state (its one side channel is thread-local). But only one thread was tested, so nothing is claimed for worker threads yet.

## How it works

- **`build.sh`:**
  - Downloads `sqlite-amalgamation-3540100.zip` from sqlite.org and checks its SHA3-256 against the value pinned from sqlite.org's download page (`92281c86…28e30`, taken from the page's PRODUCT line on 13 Nov 2026). It refuses to build on a mismatch.
  - Compiles `sqlite3.c` with the options in the script: thread-safe, FTS5, JSON, math, RTREE, column metadata, session; load_extension, shared cache and deprecated APIs omitted; DQS off. These are chosen to be close to Node's own build.
  - Compiles `native/shim.c` with `-Wall -Wextra -Werror`, and writes the two static archives to `build/lib/`. With `SQLITE_SANITIZE=1` it writes AddressSanitizer builds to `build/lib-san/`.
- **`ffi.json`** (format 7) links the two archives and `-lm`. (Day 1 also had `ffi-sanitize.json` for the sanitized pair; since day 2, `bin/scriptc-sqlite.mjs --sanitize` writes that manifest.)
- **`native/shim.c`** (about 200 lines) wraps SQLite in fixed signatures:
  - Handles cross as `pointer` (bigint), results as `i32`/`i64`/`f64`.
  - Strings and bytes go in as borrowed spans.
  - **Text and blobs come out through a buffer TypeScript owns:** the C function copies what fits and returns the full length, and TypeScript calls again with a buffer of that size if it was too small (`readText`/`readBytes` in `src/sqlite.ts`, with a 256-byte scratch buffer that grows).
- **`src/sqlite.ts`** follows Node's binding and reading rules:
  - Binding: number → REAL, bigint and boolean → INTEGER, string → TEXT, Uint8Array → BLOB, null → NULL.
  - Reading: INTEGER → number or bigint, REAL → number, TEXT → string, BLOB → Uint8Array, NULL → null.
  - Errors carry Node's error codes.
- **One test file for both runtimes:** `package.json` maps the import `#sqlite` to `./src/node-sqlite.ts` under the `node` condition (a one-line re-export of `node:sqlite`) and to `./src/sqlite.ts` by default. scriptc resolves with `types`/`import`/`default` and skips `node`. Node refuses `node:sqlite` itself as an imports target (`ERR_INVALID_PACKAGE_TARGET`), hence the re-export file.
- **`run.sh`** builds everything and runs Node, release, sanitized and `small.mts`. It compares outputs with `cmp` and writes `build/summary.txt`. `tools/peakrss.c` measures peak memory, because the sandbox had no `/usr/bin/time`.

To reproduce: `npm ci && sh run.sh` (about 4 minutes here, most of it the two SQLite compiles).

## What got in the way in the FFI

1. **No string or byte returns.**
   - Every text or blob value costs two FFI calls when it is longer than the scratch buffer, and three copies: SQLite's buffer, scratch, then the decoded string or sliced array.
   - The two-call pattern also relies on SQLite keeping the value stable between the calls. It does until the next step, reset or finalize, but that is an assumption the FFI cannot check.
   - A `returns: "string"` with a free function named in the manifest would remove all of this.
2. **No out-parameters.**
   - `sqlite3_open_v2` and `sqlite3_prepare_v2` return both a handle and a code.
   - The open code is read back from the handle (`sqx_open_failed`). The prepare code goes through a thread-local side channel (`sqx_prepare_rc`), because a NULL statement can mean either an error or empty SQL.
   - Small, but every C API with out-parameters needs such a wrapper.
3. **Empty spans may arrive as a null pointer.** SQLite binds a null pointer as NULL, so the shim binds empty text and empty blobs explicitly. Without that, empty strings came back as NULL. The docs do say this ("an empty span may have a null pointer"), but it is an easy trap.
4. **`--lib` builds have no outbound FFI** (docs). So this cannot ship as a ready-made scriptc library: every program that uses it must pass `--ffi ffi.json` at build time, and the manifest's paths are relative to the manifest. That is a packaging question for day 2.
5. **Variadic C** (`sqlite3_db_config`) has to be called from the shim. That was already planned; the docs say so.
6. **Toolchain:** the published scriptc needs `clang` on PATH to link (`SC3004 spawnSync clang ENOENT` otherwise). In the sandbox that was LLVM 22; on macOS, Xcode's clang works.
   - npm blocked scriptc's postinstall (`allowScripts`), and I ran `scripts/install-native.mjs` by hand before the first build. `scriptc --version` worked without it; I did not test whether builds do.
7. **Not the FFI, but met in the test:** scriptc refuses dot access on index-signature types (`row.x` on a `Record`, SC1090), so the test uses `row["x"]`.

## macOS and Windows (not built)

- **macOS (arm64, x64):**
  - The same `build.sh` should work with Xcode's clang and `ar`. Build once per architecture, because scriptc builds one target at a time; or use `zig cc -target aarch64-macos` / `x86_64-macos` from Linux.
  - `-lm` is harmless there (it is part of libSystem) but unnecessary.
  - The manifest needs per-target archive paths, so one `ffi.<target>.json` each, or a generated manifest.
  - Cross-building the program itself needs zig and the `@scriptc/runtime-darwin-*` pack, per scriptc's platform docs.
- **Windows (x64):**
  - scriptc targets `x86_64-windows-gnu` through zig, so compile the amalgamation and shim with `zig cc -target x86_64-windows-gnu` into `.a` archives.
  - Drop `m` from `system_libraries`.
  - SQLite uses Win32 threads and file locking there; `_Thread_local` is fine in zig's clang. Paths given to `DatabaseSync` are UTF-8, which SQLite's Windows VFS converts.
  - Untested: whether scriptc's Windows link accepts archives built this way.
- **Musl Linux:** same as glibc with `zig cc -target aarch64-linux-musl`. The program then links statically.

## Files

- `build.sh`: fetch, verify and compile SQLite and the shim.
- `ffi.json`: SQLite's manifest. `bin/scriptc-sqlite.mjs` writes merged manifests with absolute paths into `build/manifests/`.
- `bin/scriptc-sqlite.mjs`: the build command.
- `README.md`: for users.
- `example/`: a separate project that uses the package, with its own C function; `example/readme.ts` is the README's example.
- `native/shim.c`: the C layer.
- `src/sqlite.ts`: the module. `src/node-sqlite.ts` is Node's side of `#sqlite`.
- `test.mts`: the comparison test.
- `threads.mts`: worker threads.
- `small.mts`: the memory figure.
- `pool.mts`: the statement pool (scriptc only).
- `run.sh`: everything, through `bin/scriptc-sqlite.mjs`, with the summary in `build/summary.txt` (about 8 minutes here).
- `tools/peakrss.c`: peak memory of a child process.
- `build/` and `node_modules/` are ignored by git.

## Next (not started)

- User functions and aggregates, through FFI callbacks.
- The macOS build, checked on the Mac. That is also where memory figures count.
- `returnArrays` as a separate, separately typed call, if wanted.
- Publishing that survives a plain `npm install`. This needs scriptc to compile the TypeScript sources of a copied package, or a different packaging scheme. A question for upstream, with the owner's go.
- A ThreadSanitizer run of `threads.mts`.
- Whether the published scriptc builds without its postinstall step.
- A query library on top, once one compiles without Node islands.
