# SQLite for stock scriptc: notes

Separate from the move work. Uses the published `scriptc@0.4.12` from npm (installed in this folder), not the fork.

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
- **No timings:** this box's timings are not results.

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
- **`ffi.json`** (format 7) links the two archives and `-lm`; `ffi-sanitize.json` links the sanitized pair.
- **`native/shim.c`** (about 200 lines) wraps SQLite in fixed signatures:
  - Handles cross as `pointer` (bigint), results as `i32`/`i64`/`f64`.
  - Strings and bytes go in as borrowed spans.
  - **Text and blobs come out through a buffer TypeScript owns:** the C function copies what fits and returns the full length, and TypeScript calls again with a buffer of that size if it was too small (`readText`/`readBytes` in `src/sqlite.ts`, with a 256-byte scratch buffer that grows).
- **`src/sqlite.ts`** follows Node's binding and reading rules:
  - Binding: number → REAL, bigint and boolean → INTEGER, string → TEXT, Uint8Array → BLOB, null → NULL.
  - Reading: INTEGER → number or bigint, REAL → number, TEXT → string, BLOB → Uint8Array, NULL → null.
  - Errors carry Node's error codes.
- **One test file for both runtimes:** `package.json` maps the import `#sqlite` to `./src/node-sqlite.ts` under the `node` condition (a one-line re-export of `node:sqlite`) and to `./src/sqlite.ts` by default. scriptc resolves with `types`/`import`/`default` and skips `node`. Node refuses `node:sqlite` itself as an imports target (`ERR_INVALID_PACKAGE_TARGET`), hence the re-export file.
- **`run.sh`** builds everything and runs Node, release, sanitized and `small.mts`. It compares outputs with `cmp` and writes `build/summary.txt`. `tools/peakrss.c` measures peak memory, because the box has no `/usr/bin/time`.

To reproduce, from the top of the workspace: `. sqlite/env.sh && sh sqlite/run.sh` (about 4 minutes here, most of it the two SQLite compiles). `cd sqlite && npm ci` first in a fresh checkout.

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
4. **`--lib` builds have no outbound FFI** (docs). So this cannot ship as a ready-made scriptc library: every program that uses it must pass `--ffi sqlite/ffi.json` at build time, and the manifest's paths are relative to the manifest. That is a packaging question for day 2.
5. **Variadic C** (`sqlite3_db_config`) has to be called from the shim. That was already planned; the docs say so.
6. **Toolchain:** the published scriptc needs `clang` on PATH to link (`SC3004 spawnSync clang ENOENT` otherwise). Here that is the box's LLVM 22, via `sqlite/env.sh`.
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
- `ffi.json`, `ffi-sanitize.json`: the manifests.
- `native/shim.c`: the C layer.
- `src/sqlite.ts`: the module. `src/node-sqlite.ts` is Node's side of `#sqlite`.
- `test.mts`: the comparison test. `small.mts`: the memory figure.
- `run.sh`: everything, with the summary in `build/summary.txt`.
- `tools/peakrss.c`: peak memory of a child process.
- `env.sh`: puts clang on PATH (sources the workspace's `.fern/env.sh`).
- `build/` and `node_modules/` are ignored by git.

## For day 2 (not started)

- `finalize()` and a statement cache.
- `iterate()`.
- Null-prototype rows if scriptc can make them.
- User functions through FFI callbacks.
- Worker-thread test.
- A packaging story given that `--lib` has no FFI.
- Check whether the published build works without the postinstall step.
- A query library on top, once one compiles without Node islands.
