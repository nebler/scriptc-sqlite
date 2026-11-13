# SQLite for stock scriptc: notes

Uses the published `scriptc@0.4.12` from npm. Days 1 and 2 were built and checked in a Linux arm64 sandbox (gVisor); macOS arm64 was checked afterwards. Day 3 ran in a different Linux arm64 sandbox, with Zig as the C toolchain.

## Day 5, continued: runMany and numberFunction

**`stmt.runMany(count, bind)`** and **`db.numberFunction(name, fn)`** (README, "Fast writes and number functions"), for the two workloads where Goose was still ahead after typed reads (inserts 1.25×, functions 2.6× on Linux arm64).

- **Inserts:** 1060 ms against 1555 ms with `run()` in a loop, on the Linux arm64 host. `runMany` takes a statement from the pool once, binds through a `Parameters` object by position (the anonymous-parameter indexes found once), and steps, resets and clears bindings in one C call per row (`sqx_step_reset`), adding up `sqlite3_changes64` in a C thread-local.
- **Functions:** 163 ms against 293 ms with `db.function`. The function has a fixed type, `(a: number, b: number, c: number, d: number) => number`, so scriptc calls it directly instead of through an `unknown` function (an adapter, boxing every argument). Arguments come from C as doubles in one call each (`sqx_value_number`, NaN for a non-number); the dispatcher also lost a redundant `try/finally` and gained a one-entry cache in front of the function map.
- **What's left in the function job:** mostly SQLite (the VM, `sum`, page reads) and the scriptc callback trampoline.

## Day 5, continued: typed reads

**`StatementSync.map()` and `forEach()` with a typed column reader** (README, "Fast typed reads"). With Node's API, most of a read is building a dynamic row object and the caller's `row as T` check (about 1.3 µs a row here, against 0.17 µs for SQLite itself). Reading columns by index into an object literal of a declared type skips both.

- **Read 1M rows on the Linux arm64 host:** 490 ms typed against 1746 ms through `iterate()`; text 254 against 410 ms. A prototype without any checks took 445 ms, so the checks cost about 10%.
- **Checks kept:** each read checks the column's type in the same C call that reads it (NaN or −1 back on a mismatch, then a second call to name the type); the row checks a liveness token that `close()` and `deserialize()` invalidate, so a reader can never touch a finalized statement; the statement checks between rows that it wasn't run again (Node's "iterator was invalidated").
- **Under Node** `src/node-sqlite.ts` adds the same methods over `iterate()` with array rows. `typed.mts` compares the two byte for byte, release and sanitized.
- **What's left in a typed read:** about 30% SQLite, about 20% scriptc working out `.length` of non-ASCII text (the caller's code; Go and Rust count characters too), the rest FFI calls and string decoding.
- **SQLite's own build flags** (`-O3` against `-O2`): about 2%, within noise; left at `-O2`.

## Day 5, 13 November 2026: performance

**Every workload got faster, none slower; outputs still identical to Node.** Profiled with `perf` on a quiet Linux arm64 host (4 Neoverse-N1 cores, outside any sandbox), each change timed alone (median of 5 to 7 whole-process runs, min within 2% of the median) and kept only if it helped. The box timings rule still holds: none of these numbers come from a sandbox.

| Workload (1M rows; text 100k) | before | after | Node 24 on the same host |
|---|---|---|---|
| read | 2635 ms | 1759 ms | 2766 ms |
| insert | 2763 ms | 1731 ms | 2698 ms |
| text | 527 ms | 414 ms | 1265 ms |
| udf | 1038 ms | 292 ms | 365 ms |

On GitHub's runners (PR #1 comment), scriptc ÷ Node went from 1.14 (insert), 1.13 (read), 0.75 (text) and 3.20 (udf) on Linux x64 to below 1 everywhere but udf (1.05) after the first two rounds; the comment on the PR has the current tables for all three platforms.

### What it took

| Change | Where it paid |
|---|---|
| A new `TextDecoder` per value instead of one shared decoder (a reused one costs ~3× in scriptc 0.4.12) | read −20% |
| Positional parameter indexes found once per statement, not `sqlite3_bind_parameter_name` + a text decode per parameter per `run()`; parameter count cached too | insert |
| No closure per text or blob value (`readText((out) => …)`) | read, text |
| SQL functions: no argument array and spread for up to 3 arguments | udf −54% |
| SQL functions: the call's context and arguments stay in C thread-locals (saved and restored around nested calls); TypeScript gets `(op, id, argc)` as plain numbers, so no pointer bigint per call; integer arguments come as doubles when safe | udf −21% |
| SQL functions: the user's callbacks cast to a callable type once at registration, not on every call (the cast built an adapter closure each time) | udf −24% |
| `SQLITE_OPEN_NOMUTEX`: a connection never leaves its thread in scriptc, so SQLite's serialized-mode mutex on every step and column read was pure cost (a third of a plain C scan) | read −7%, insert −5% |
| Lengths and row sizes returned as doubles, integer columns as a double when safe, `changes`/`lastInsertRowid` as doubles unless `readBigInts`: no bigint per row or value | read, insert |
| Statement pool: the statement just given back waits outside the map (one string comparison to take it again); statements in use kept in an array (a pop) instead of a `Set<bigint>` (two hashes per `run()`) | insert −10% |
| Per-value row reads by default again: packed reads (day 4) were slower on macOS and no faster on Linux, because an FFI call costs a few nanoseconds; `SCRIPTC_SQLITE_ROW_READS=packed` keeps them for comparison | read (macOS) |

### What scriptc costs (scriptc 0.4.12, measured with small programs on the same host)

- **FFI calls are cheap:** ~5 ns with a pointer (bigint) argument, ~2 ns with a double; an `i64` return ~11 ns against ~4 ns for `f64`.
- **Dynamic values are not:** casting a row (`Record<string, …>`) to an object type checks every field, ~450 ns per row; reading three fields by index from such a row is slower still. This is in the caller's code and dominates the read benchmark. Calling a function held as `unknown` through a cast built an adapter closure per call (~320 ns for the 8-parameter `SQLFunction` shape, ~40 ns for a function typed `(x: number) => …`).
- **Things that cost nothing much:** `for…of` over a class iterator (~15 ns per row), creating a null-prototype object with three keys inline (~150 ns).
- **`--optimization speed`** gained 1–5%: not worth a different default.

### Tried and not kept

- **Typed parameters** (`...params: SQLParameter[]` instead of `unknown[]`): no faster, and it would refuse calls Node accepts (tests pass `undefined` on purpose).
- **Finalizing every statement of the connection in C** (`sqlite3_next_stmt`) on close, instead of tracking the lent ones: crashed the demo, because FTS5 keeps statements of its own on the connection and finalizes them itself. The demo session in `run.sh` caught it.
- **A callback from C carrying a `string`** (decoded by scriptc) instead of copying into a buffer and decoding: ~20% faster per string, not worth a second path.
- **Calling every function as the 8-parameter shape** (~10× faster per call): wrong for a function with a rest parameter, which would see 8 arguments instead of Node's count, and scriptc gives no way to tell such a function apart at run time.

### Where the gaps are now

- **Reads are still 2–4× behind Bun and Rust.** What is left is mostly building and checking dynamic row objects in scriptc, on both sides of the API. A typed read API (rows built as fixed shapes the compiler knows) is the way past it; that is a feature, not a fix.
- **SQL functions** are close to Node; the rest is boxing arguments for a call through an unknown function type.

## Day 4, 13 November 2026: result

**Done, release lane only (still no AddressSanitizer runtime in this box):**
- benchmarks against Node, Deno, Bun, Go and Rust;
- packed row reads;
- `location`, `serialize`, `deserialize` and `backup`;
- migrations (`scriptc-sqlite/migrate`);
- the query builder's gaps;
- a demo app, a starter project, and workflows for benchmarks and demo binaries.

Two bugs found and fixed on the way, and one large scriptc memory cost found and worked around (below).

| Program | Release vs Node | Peak memory, scriptc vs Node |
|---|---|---|
| `test.mts` (now also location, serialize/deserialize, backup, ALTER TABLE under a reused statement) | identical; also identical with `SCRIPTC_SQLITE_ROW_READS=columns` | 127 vs 199 MiB |
| `query.mts` (now also createTable/createIndex/dropTable, aliases and a self-join, subqueries, upserts; 13 compile-time refusals) | identical | 77 vs 150 MiB |
| `migrate.mts` (new) | identical | 57 vs 147 MiB |
| `threads.mts`, `udf-threads.mts`, `small.mts` | identical | 151 vs 262, 197 vs 268, 37 vs 143 MiB |
| `demo/` session, starter project, benchmark `--check` (scriptc, per-column reads, Node) | as expected | — |

Test binary 3.0 MB stripped (9.7 MB unstripped), links libc and libm only.

### Benchmarks (`bench/`, `.github/workflows/bench.yml`)

- **What it runs:** the same five workloads in seven forms: scriptc, scriptc with per-column reads, Node, Deno, Bun, Go (mattn/go-sqlite3) and Rust (rusqlite, bundled).
  - **start-up:** one query on a small database;
  - **insert:** a million rows in one transaction;
  - **read:** a million rows;
  - **text:** 100,000 rows of 1 KB text and 4 KB blobs;
  - **udf:** a user function over a million rows.
- **What it measures:** median, min and max time over 15 runs after 2 warm-ups, peak memory, and binary or runtime size. Every program prints a checksum, and the harness checks they agree. `bench/README.md` has the fairness caveats: different SQLite versions and build options, how much each API does per row, and Bun having no user functions.
- **Checked here with `--check` only** (small inputs, no timings): all seven agree. SQLite versions: scriptc and Node 3.54.1, Deno 3.53.2, Bun 3.53.0 (the system's on macOS), Go 3.50.4, Rust 3.50.2. Sizes: scriptc binary 2.4 MB stripped, Go 6.8 MB, Rust 2.1 MB; runtimes Node 123 MB, Deno 86 MB, Bun 92 MB.
- **No timings yet:** this box's clock is not valid. **The "Benchmarks" workflow has to run on GitHub's machines to give the first numbers.** It uses Linux x64, Linux arm64 and macOS 15.
  - **It runs on every pull request** that touches `src/`, `native/`, `build.sh`, `ffi.json`, `bin/`, `bench/` or the lockfile (5 timed runs), and **posts the tables as one PR comment**, updated on later pushes. Fork PRs get the run but no comment (their token can't write).
  - **By hand from the Actions tab:** 15 runs by default.
- **Toolchains for the check here:** `bench/mise.toml` pins Bun 1.3, Deno 2, Go 1.25 and Rust 1.91. Source `.fern/bench-env.sh` after `.fern/env.sh` (not committed). Go's cgo and Rust's bundled SQLite compiled through the Zig wrappers.

### Packed row reads

- **Before,** a row cost one FFI call to step plus one or two per value (type, then the value; text and blobs a second time when longer than the scratch buffer). A row of four columns took about 11 calls into C.
- **Now** `sqx_step_row` steps and packs the whole row into one buffer: a type byte per column, then 8 little-endian bytes for an integer or a float, or a 4-byte length and the bytes. TypeScript unpacks it with a `DataView`. One call per row.
- **Integers:** read as numbers without a BigInt while the high word is within ±2^21. Node's range rule (`ERR_OUT_OF_RANGE` beyond ±(2^53−1)) is kept exactly.
- **The old path stays** behind `SCRIPTC_SQLITE_ROW_READS=columns`, for the benchmark and as a fallback. `run.sh` runs `test.mts` both ways.
- **Gain: unmeasured.** The benchmark's `scriptc` and `scriptc-columns` rows will show it.

### Bugs found

1. **A reused statement missed columns added by ALTER TABLE** (since day 2). The module read a pooled statement's column names before the first step, but SQLite recompiles a statement for a changed table *during* that step. Found by the migration test; names are now read when the first row arrives. `test.mts` covers it.
2. **The demo and starter paid tens of MiB for `process.env`** (next section).

### scriptc's memory: `process.env` is expensive

Peak memory of one-line programs, release build:

| Program | Peak memory |
|---|---|
| `console.log("hi")` | 3.9 MiB |
| …reading `process.env["HOME"]` | **43 MiB** |
| …reading `process.argv` | 7.1 MiB |
| …a RegExp | 15 MiB |
| …`JSON.parse`/`stringify` | 14 MiB |
| …an `async` function | 12 MiB |
| …`Map` and `Set` | 11 MiB |
| …`node:fs` `readFileSync` | 7.3 MiB |

- **Everything but `process.env` is a normal one-time cost;** `process.env` costs about ten times more. In this module it cost every thread: `threads.mts` went from 151 to 226 MiB when the row-read switch was read from `process.env` (found by bisecting).
- **The fix:** the switch is now read in C (`getenv`).
- **`getEnv(name)`** is new in `scriptc-sqlite`. It isn't part of node:sqlite; it reads a variable through C. The demo, the starter and the example use it for their database paths.
- **Worth telling scriptc's authors**, with your go (no issue was filed).

### `location`, `serialize`, `deserialize`, `backup`

- **They follow Node 24.22's C++** (`node_sqlite.cc`): same checks, messages, error codes and defaults.
  - `deserialize` finalizes the connection's statements first; later calls get "statement has been finalized", as in Node. It also refuses inside a function callback.
  - `backup` validates synchronously and runs asynchronously. Node copies on its thread pool; here each round of `rate` pages runs on the program's thread, with a timer turn between rounds. The progress calls and the result are the same.
- **`serialize` copies once:** the shim keeps SQLite's copy until TypeScript takes it, instead of serializing twice to learn the size.
- **The test prints facts about the bytes, not the bytes:** serialized bytes carry the SQLite version that wrote them, and Node's build isn't ours.

### Migrations (`src/migrate.ts`, `scriptc-sqlite/migrate`)

- **What it does:** applies a list of changes in order, each in a transaction (or not, with `transaction: false`), recorded in `_migrations` with a checksum of the SQL.
- **What it refuses:** an edited, renamed or reordered change, a duplicate name, and a database newer than the program.
- **When a change fails:** it is rolled back and thrown as `MigrationError`; the changes before it stay.
- **`migrate.mts` covers each of these,** compared with Node.

### The query builder, continued

- **New:** `createTable`/`createIndex`/`dropTable` from the declarations. NOT NULL follows `nullable()`; `primaryKey()`, `unique()`, `references()` and `defaultTo()` are column methods, and composite keys are an option.
- **New:** table aliases (`table(name, freshColumns(), alias)`) for self-joins; `inSelect`, `exists` and `scalar` subqueries, correlated through column references; and upserts (`onConflictDoNothing`, `onConflictDoUpdate`).
- **Refused with clear errors:** misuse (`where()` on an insert, an upsert on an update, writing through an alias, reusing column objects in a second table).
- **One more scriptc limit, worked around:** `same(a, op, b)` with one type parameter made TypeScript widen `Column<number>` to `Expr<number | null>` when the other side was nullable. scriptc compiles those as unrelated classes and refuses ("using a Column instance as the unrelated class Expr", SC1090). `same` now has two type parameters (`B extends A | null`).

### Demo, starter and binaries

- **`demo/` (marks):** bookmarks with FTS5 search and highlighting, tags, per-site stats through a user function, JSON export and import (upserts), and backups.
  - **Size and memory:** 3.0 MB stripped (9.7 MB unstripped), libc and libm only; `marks stats` peaks at 53 MiB.
  - **Check:** `demo/session.sh` runs every command; `run.sh` compares the output with `demo/session.expected`.
- **`template/`:** a starter project for `npx degit nebler/scriptc-sqlite/template`. `setup.mjs` downloads this repository's `main` (or `SCRIPTC_SQLITE_REF`) into `vendor/`, or links a checkout (`SCRIPTC_SQLITE_SOURCE`), then installs. This is the way around SC2013 (a copied package isn't compiled).
  - `run.sh` sets it up from this checkout, builds and runs it.
  - The download was tried against GitHub's current `main`: it unpacks and installs. **Building from it needs this work pushed first,** since `main` doesn't have `scriptc-sqlite/query` or `/migrate` yet.
- **`.github/workflows/demo-binaries.yml`:** manual. It builds marks for Linux x64, Linux arm64 and macOS arm64, checks each against the expected session, and uploads the stripped binaries as run artifacts. It publishes no release.

## Day 3, 13 November 2026: result

**Done: user-defined functions and aggregates (`database.function`, `database.aggregate`), checked in the release lane only.** The sanitized lane could not run here: see "Toolchain" below. **Re-run `sh run.sh` with real LLVM before trusting day 3's C and FFI code under AddressSanitizer.**

| Program | What it checks | Release vs Node | Sanitized | Peak memory, scriptc vs Node |
|---|---|---|---|---|
| `test.mts` (209 lines of output, 95 new) | days 1–2, plus functions and aggregates (list below) | identical | **not run** | 124 vs 189 MiB |
| `udf-threads.mts` (new) | 4 worker threads defining the same function names differently and calling them at once | identical | **not run** | 199 vs 271 MiB |
| `threads.mts`, `small.mts` | as on day 2 | identical | **not run** | 151 vs 261, 38 vs 141 MiB |
| `pool.mts` (scriptc only) | day 2's statement pool, plus: 10,000 redefinitions, 1,000 abandoned GROUP BY queries, 1,000 databases opened and closed with functions | — | **not run** | 47 MiB; 2 functions left after the redefinitions, 0 groups, 0 functions after closing |
| `example/`, README example | as on day 2 | builds and runs | — | — |

- **Memory per call is flat:** one thread, with three user functions per row, peaked at 38.5, 37.4 and 38.7 MiB for 0.2, 1 and 4 million calls (`.fern/` scratch program, not kept). `udf-threads` is high because of its four threads, as with `threads.mts`.
- **Sizes:** the test binary is 9.5 MB unstripped and 2.85 MB stripped (day 2: 2.8 MB unstripped). The difference is debug info `zig cc` keeps, not code; stripped sizes compare. It still links only libc and libm.

### Toolchain: Zig instead of LLVM

The box had Node 20 and no clang, ar, strip or readelf. `mise.toml` pins Node 24 and Zig (0.17.1 resolved). `.fern/env.sh` (not committed: `.fern/` is the sandbox's own folder) puts wrappers on PATH:
- **`clang` → `zig cc`, with two rewrites:**
  - scriptc links with `-target aarch64-unknown-linux-gnu`, which Zig refuses (`unable to parse target query ... UnknownOperatingSystem`). It becomes `aarch64-linux-gnu.2.41`, with the box's glibc version.
  - scriptc links `-lgcc_eh` (GCC's unwinder), which Zig doesn't ship. It becomes `-lunwind`, Zig's bundled LLVM libunwind.
- **`ar` → `zig ar`.**
- **`strip` and `readelf -d`:** a small Node script, because `zig objcopy --strip-all` (and `-g`) answers `error: unimplemented` for these ELF files in both Zig 0.17.1 and 0.15.2. It drops the sections the loader doesn't map, as `strip` does, and the stripped binaries run identically.

With that, **the release lane links and passes.** **The sanitized lane cannot link:** Zig compiles `-fsanitize=address` but ships no AddressSanitizer runtime (`libclang_rt.asan`), so every sanitized link fails with `undefined symbol: __asan_init`, `__asan_report_load1` and so on. A one-line C program shows the same thing. `run.sh` therefore gained `SANITIZE=0`, which skips that lane and ends with "PASS, sanitized lane skipped", never a plain PASS. CI and the default run are unchanged.

### How user functions work

- **SQLite keeps a function's callbacks long after the call that registers it**, so they can't be call-scoped FFI callbacks. The module registers **one retained scriptc callback per thread** (`sqx_set_dispatch`, a callback with a context pointer, never released). Every function and aggregate goes through it:
  - The shim registers C functions (`x_func`, `x_step`, `x_inverse`, `x_value`, `x_final`, `x_destroy`) with the function's id as SQLite's user-data pointer.
  - They call the dispatcher with an operation, that id, and SQLite's context and argument pointers.
  - TypeScript reads the arguments (`sqx_value_*`, through the same caller-owned buffers as columns) and sets the result (`sqx_result_*`).
- **Exceptions never cross into C.** In scriptc, a callback that throws returns 0 to C, and the exception resumes once the outer native call returns. That stays catchable (tested: the process survives), but it would hand SQLite a half-finished state.
  - So `dispatch` catches everything, keeps the first exception, and returns a failure code. The shim fails the SQL function with an empty message.
  - `run`/`get`/`all`/`iterate`/`exec` then throw that exception object itself instead of SQLite's error, as Node does: `error === thrown` holds, and subclass fields survive.
- **Aggregate state:** a per-group number lives in SQLite's aggregate context, and the accumulator lives in a TypeScript map under that number, created from `start` on first use. It is removed in `xFinal`, which SQLite also calls for groups abandoned by a reset.
- **Functions are forgotten when SQLite drops them** (replaced, or the connection closed): `x_destroy` tells the dispatcher. `pool.mts` checks that functions and groups go back to 0.
- **Threads:** the dispatcher and the function table are thread-local, like the rest of the module. A thread only ever runs its own closures; `udf-threads.mts` checks this with four threads defining the same names differently.

### What the new tests cover (all compared with Node)

- **Arguments and results of every type:** integers (as numbers, or bigints with `useBigIntArguments`), reals, Unicode text, empty text, text with NUL, all 256 byte values, empty blob, NULL, a 1 MiB blob, a 308,890-character string, 2^53+1 and 2^63-1.
- **Out-of-range values:** an argument above 2^53 without bigints throws `ERR_OUT_OF_RANGE`.
- **Results Node converts or refuses:** `undefined`/NaN → NULL, -0, -Infinity, bigint 2^63-1. A bigint out of range, or a boolean, is an SQL error with Node's message.
- **Arity:** wrong argument counts; `varargs` with rest and with fixed parameters (missing ones are `undefined`); rest parameters without `varargs` (length 0); replacing a function, and two arities under one name.
- **deterministic:** refused without it in a generated column and an index. With it: STORED and VIRTUAL generated columns, an expression index used with `INDEXED BY`, and an UPDATE that recomputes.
- **directOnly:** allowed directly; refused in a view, a trigger and a generated column ("unsafe use of secret()").
- **Exceptions:** from `get`, `all`, `run`, `exec` (third statement of three), a WHERE clause, and mid-`iterate` (rows before it arrive). Also inside a transaction (still open afterwards), and the database still working afterwards.
- **A function that runs SQL on its own connection**, which calls another user function.
- **Aggregates:**
  - `start` as a value and as a function, `result`, GROUP BY, two aggregates in one SELECT, no rows (with and without GROUP BY).
  - Bigint arguments summing to 2^63-1, `varargs`, a step taking only the accumulator.
  - A window function with `inverse` (compared with the built-in `sum` over the same frame, and with partitions), the same used as a plain aggregate, and an aggregate without `inverse` refused as a window.
  - Exceptions in `start`, `step`, `inverse` and `result`, as an aggregate and as a window.
  - `directOnly` in a view.
- **Node's argument checks typed code can reach:** not a function, `start` missing, `step` or `inverse` not functions; both methods on a closed database.

### Differences from Node found today

1. **Function types.** Node declares `function(name, [options], fn: (...args: SQLOutputValue[]) => SQLInputValue)`. scriptc 0.4.12 can't pass a function with fixed parameters, such as `(a, b) => …`, where a rest parameter is declared (SC1090, "variadic function values where another signature is expected"). So the module declares overloads:
   - **First,** `SQLFunction`: eight *required* parameters of type `SQLOutputValue | undefined`. An unannotated `(a, b) => …` is typed by this first overload and compiles. Its parameters include `undefined`, so code casts (`a as number`). `fn.length` is still 2, as in Node.
   - **Second,** `fn: any`: annotated functions, rest parameters, functions returning `undefined`. scriptc passes any function through an `any` slot.
   - **The same for aggregates:** `AggregateOptions` with an unannotated step shape, then `AnyAggregateOptions`.
   - **Catch:** a step written `(acc: unknown, ...xs: unknown[])` matches the first shape in TypeScript, and scriptc then refuses it (SC1090: it can't turn "fixed then rest" into fixed parameters). Give the accumulator a narrower type, such as `(acc: number, ...xs: SQLOutputValue[])`, and it takes the second signature. A rest-only function `(...xs) => …` works either way.
   - Things tried that don't compile in 0.4.12: casting a union of function types to one member (SC2003, also in branches that never run); optional parameters `(a?: V)` (SC1090); rest parameters in a fixed slot (SC2001, tuple types).
2. **Node 24 loses an aggregate's exception in one case; this module doesn't.** If an aggregate has a `result` function and its `step` throws, Node's `get()` returns `undefined` and so does `all()` (not even an empty array). Here the step's exception is thrown.
   - Without `result`, or as a window function, Node throws too, so the shared test checks only those cases.
   - Why: SQLite still runs the final callback, Node calls `result` while the step's exception is pending, and the exception is lost. A data-losing quirk, so it is not copied. `pool.mts` checks this module's behavior.
3. **Typed arrays other than `Uint8Array`, and `ArrayBuffer`,** returned from a function, are an SQL error here ("cannot be converted"); Node takes any `ArrayBufferView` as a blob. Same rule as binding.
4. **Like Node, `aggregate` ignores `deterministic`.** Node's `AggregateFunction` never reads that option. The module copies this, so an aggregate can't be used in a generated column or index here either.
5. **Not covered:** closing the database from inside its own function (Node throws "database is not open" afterwards; untested here); async functions are refused like any non-value (Node's message for a Promise is copied but not tested); wrong option *types* are stopped by scriptc's own type check, as on day 2.

### Typed queries that compile natively: findings and recommendation

**Recommendation: don't patch or fork Kysely. Write a small builder in the style of `research/builder.mts`: column objects, a row type fixed by `select()`. Keep Node islands for anyone who needs Kysely now.** The evidence follows. Everything ran in scratch folders (not kept), except `research/builder.mts`.

#### (a) Can Kysely's runtime patches and compiler gaps be avoided?

The probe: Kysely 0.29.9 (latest on npm) with a small dialect adapter over this module. It creates two tables, inserts one row and then three, updates, deletes, joins, and counts. Under Node with `node:sqlite` it prints the right answers.

1. **Kysely from npm** (JavaScript plus `.d.ts`): `scriptc coverage --print=diagnostics` makes it a Node island, with **18 reasons**:
   - **4 "object-model" reasons, at 3 places:**
     - `Symbol.asyncDispose ??= …` in `kysely.js`;
     - `delete value.prototype` twice, in the JSON-results plugin's prototype-pollution guard;
     - `Object.defineProperty` in `util/abort.js`, which only attaches debug timing.
   - **14 compiler gaps, of 5 kinds:**
     - a subclass redeclaring a base class's private name (`#props`, `#node`);
     - `extends Kysely`;
     - circular imports (SC1016);
     - method calls on `string | OperationNodeSource` in the parsers;
     - `Promise.race` over non-promises.

   These are the "3 runtime patches and 5 compiler gaps".
2. **The runtime patches are easy to remove.** Applied in a scratch copy (348 changed diff lines, mostly mechanical):
   - delete the polyfill line and the `Symbol.asyncDispose` method;
   - drop the two `delete` guards and the debug `defineProperty`;
   - remove `Promise.race` (abort signals only);
   - rename private fields in 12 subclasses.

   Node still gives the same answers, and the object-model reasons are gone. **But 19 gaps remain**, almost all one kind: "`string.map` has no lowering (instantiating `parseTableExpressionOrList` with string)", `exp.toOperationNode` on a string, `string.toISOString`.
   - scriptc compiles each generic instantiation with all its branches.
   - In the published JavaScript, Kysely's guards (`isReadonlyArray`, `isOperationNodeSource`) are plain functions it can't narrow through.
   - The same guards *do* work in TypeScript: a test with user-defined type guards, `typeof`/`Array.isArray`, and `instanceof` compiled and ran in all three styles.
3. **So the fork's best case is Kysely's own TypeScript sources**, linked as a `file:` package, which scriptc compiles from source. That is the v0.29.9 tag, 304 files, unpatched. **Result: no island, 3,506 of 4,056 statements compile (86%), and 523 errors in 74 files, across about 50 different limits.**
   - The "5 gaps" were only the first blocker per module the island pre-scan reports.
   - The largest kind: **174 errors, "`CreateTableBuilder%A` values where `CreateTableBuilder%B` is expected".**
     - Kysely's builders return another instantiation of their own generic class at every step (`addColumn` turns `CreateTableBuilder<TB, C>` into `CreateTableBuilder<TB, C | K>`). scriptc compiles each instantiation as its own type and won't convert between them, even when the fields are identical.
     - Eight lines reproduce it: a class `QB<O>` whose `select()` returns `QB<O & {…}>`.
     - That is how every typed builder in Kysely works (`SelectQueryBuilder<DB, TB, O>` changes `O` on every `select`).
   - Next largest: 58 calls of generic methods through a receiver whose class a subclass may override (`OperationNodeTransformer`, which every plugin extends), and 45 SC2001 "cannot be compiled yet".
4. **Getting around the main blocker:** one non-generic class seen through a generic interface whose type changes along the chain.
   - That compiles in the minimal case.
   - It breaks as soon as the factory is generic (`selectFrom<T>`) or the result is a typed row: SC2002 refuses the class-to-interface conversion, and SC1090 says "calls of the generic method … through this receiver … the receiver's runtime class must be provable".

**Answer to (a): the 3 runtime patches can be avoided with a small patch; the compiler gaps can't with a small fork.** About 50 kinds of limit sit behind them. The biggest is Kysely's central design (type parameters that change along a call chain), so a fork would rewrite its builder classes. Worth re-running the TypeScript-source probe on each new scriptc: **the number to watch is the 174 "instantiation into another instantiation" errors.** Supporting that conversion, when a class's layout doesn't depend on its type parameters, is the one compiler change that would move Kysely furthest. That is a question for upstream; it was not raised (no issues or PRs there).

#### (b) The smallest typed builder in scriptc's subset

**`research/builder.mts`** (since grown into `src/query.ts`, below, and removed): 172 lines of builder plus 40 lines that use it. It does select with join, `where` (`cmp`, `cmpCol`, `and`), `orderBy` and `limit`; insert; update; delete. Rows are typed from the selection: `select({ owner: person.c.name, age: person.c.age, pet: pet.c.species })` gives `{ owner: string; age: number; pet: string }[]`, with no cast in user code. Values are always bound, never spliced into SQL.
- **Same output as Node** (compared by hand at the time).
- **Binary:** 2.40 MB stripped (8.95 MB unstripped). Peak memory 46 MiB, against 144 MiB under Node.
- **Type errors caught at compile time** (all six refused, SC0001): comparing an integer column with a string; comparing an integer column with a text column; inserting a string into an integer column; inserting a column that doesn't exist; reading a column that wasn't selected; reading a text column as a number.
- **The rules it follows, each from a failed first try:**
  1. **Fix the row type once.** `select()` returns `Select<R>`, and later calls return the same `Select<R>`. A type parameter that changes along a chain is Kysely's blocker above.
  2. **Compute the mapped row type in a method's return type** (`select<S>(): Select<RowOf<S>>`), not inside a class generic over the selection: there, `RowOf<S>[]` "does not compile" (SC2009).
  3. **Give `Column<T>` a non-generic base** for code that walks columns at run time. scriptc has no variance, so a `Column<number>` can't enter a `Column<SQLOutputValue>` slot (SC2002).
  4. **No `Column<T> | T` parameters.** scriptc does not narrow that union with `instanceof` inside a generic (SC2003), so a value comparison and a column comparison are two functions.
  5. **No class fields typed `Record<string, unknown>[]`** (SC1090).
- **Missing for real use:** expressions in the selection (`count(*)`, `sum`, raw SQL with a declared type), `or`/`not`/`in`/`is null`, left joins (nullable columns: a second mapped type), group by/having, `returning`, subqueries, a transaction helper. In this style each is roughly 10 to 40 lines, so a usable builder is about 400 to 600 lines, tested like `test.mts`, Node against the binary.

#### What I'd do

1. **Done, see "The query builder" below:** grow `research/builder.mts` into a package-level module, `scriptc-sqlite/query`, adding the missing pieces above in this order: expressions with declared types, `or`/`in`/`is null`, left join, group by, `returning`, transactions. Give it its own Node-against-binary test in `run.sh`.
2. Leave Kysely and Drizzle as Node islands, documented with their cost (about 55 MB and 260 to 350 ms start, from earlier measurements; not re-measured today). Drizzle was not probed today.
3. Re-run the Kysely TypeScript-source probe when scriptc moves past 0.4.12.

### The query builder: `scriptc-sqlite/query` (`src/query.ts`)

The sketch grew into a package export, 527 lines, following the order recommended above. The README documents it.
- **What it does:**
  - **Tables:** `table()` with `integer`/`real`/`text`/`blob`/`nullable`; a column's SQL name defaults to its key.
  - **Selecting:** `select`/`selectAll` with `from`, `innerJoin`, `leftJoin` (with `orNull`), `where` (repeatable, ANDed), `groupBy`, `having`, `orderBy`, `limit`, `offset`, `distinct`, `all`, `first`.
  - **Writing:** `insertInto` (several rows), `update`, `deleteFrom`, each with `run()` or `returning()`.
  - **Conditions:** `eq` … `ge`, `same`, `and`/`or`/`not`, `inList`, `isNull`/`isNotNull`, `like`, `between`.
  - **Expressions:** `count`/`sum`/`avg`/`min`/`max` and `raw<T>`.
  - **Transactions:** `transaction()`, nested through savepoints.
- **It takes any node:sqlite-shaped database**, so `query.mts` runs unchanged under Node on `node:sqlite`.
- **`query.mts`:** 56 lines of output. It covers every feature above, Unicode, quoted table and column names, a blob round trip, NULLs, aggregates over no rows, a user SQL function inside a query, and the builder's own errors: no values, rows setting different columns, and a UNIQUE failure passing through.
  - **Transactions:** commit, rollback with the body's exception rethrown, and a nested failure caught by the outer body, which undoes only the inner part.
  - **Compile-time checks:** a never-called function holds 9 lines marked `@ts-expect-error`. A negative control (one line made valid) fails the build with "Unused '@ts-expect-error' directive", so the 9 refusals are enforced on every build.
- **Results (release lane):** identical to Node; peak memory 70 vs 154 MiB; binary 2.91 MB stripped. The README example builds in `example/` through the `scriptc-sqlite/query` export and prints the expected rows. **The sanitized lane hasn't run it.**
- **New scriptc limits found while writing it, and how the module avoids them:**
  - A class generic over the table can't hold a `ValuesOf<C>` (SC2001/SC2009). So `insertInto`/`update` take their values in the builder's generic methods and turn them into SQL at once, and the write is one non-generic class, `Write`.
  - A record of `Column<number>` and `Column<string>` won't convert to a record of their base class (SC2002), but it converts from `unknown`. Walking columns goes through `entriesOf(record: unknown)`, and a column's SQL name lives on the non-generic base `SqlExpr`.
  - **A scriptc bug:** if one call of a generic function passes a body that always throws (TypeScript infers `never`), the function's *other* instantiations fail: "'void' values where 'number' is expected (instantiating 'tx' with <number>)". An 8-line program reproduces it (try/catch around `return body()`, one call returning 42 and one that throws). Declaring the throwing body `(): void => …` avoids it. The test does that; the README warns about it.
- **Not there yet:** subqueries, self-joins (no table aliases), upserts, `create table` from the declarations, and left joins made nullable by type rather than by `orNull()`.

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
- **`native/shim.c`** (about 370 lines since day 3) wraps SQLite in fixed signatures:
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
- `udf-threads.mts`: user functions on four worker threads at once.
- `example/readme-functions.ts`: the README's SQL-function forms, built and run by `run.sh`.
- `src/query.ts`: the typed query builder, `scriptc-sqlite/query`. `query.mts` is its comparison test.
- `src/migrate.ts`: migrations, `scriptc-sqlite/migrate`. `migrate.mts` is its comparison test.
- `bench/`: the benchmarks (`bench/README.md`); `.github/workflows/bench.yml` runs them.
- `demo/`: marks, the demo app, with `session.sh` and `session.expected`; `.github/workflows/demo-binaries.yml` builds it per platform.
- `template/`: the starter project.
- `FINDINGS.md`: problems found in scriptc and Node.js, each written as a ready-to-file report with a verified repro.
- `example/readme-query.ts`: the README's query example, built from the example project through the package export.
- `mise.toml`: Node 24 and Zig, for a machine without LLVM (day 3); with LLVM on PATH it isn't needed.
- `small.mts`: the memory figure.
- `pool.mts`: the statement pool (scriptc only).
- `run.sh`: everything, through `bin/scriptc-sqlite.mjs`, with the summary in `build/summary.txt` (about 8 minutes here).
- `tools/peakrss.c`: peak memory of a child process.
- `build/` and `node_modules/` are ignored by git.

## Next (not started)

- **Run the sanitized lane for days 3 and 4** (`sh run.sh` with LLVM 22). Nothing since day 2 has run under AddressSanitizer: user functions, `udf-threads.mts`, `query.mts`, `migrate.mts`, packed rows, serialize/backup.
- **Run the "Benchmarks" workflow** for the first real numbers, then decide what to optimize next.
- The query builder's missing pieces: compound selects (`union`), window functions, nullable types from left joins without `orNull()`.
- Report what's in `FINDINGS.md` (scriptc issues with repros, and one Node.js bug), with the owner's go. Nothing is filed yet.
- The macOS build, checked on the Mac. That is also where memory figures count.
- `returnArrays` as a separate, separately typed call, if wanted.
- Publishing that survives a plain `npm install`. This needs scriptc to compile the TypeScript sources of a copied package, or a different packaging scheme. A question for upstream, with the owner's go.
- A ThreadSanitizer run of `threads.mts`.
- Whether the published scriptc builds without its postinstall step.
- A query library on top, once one compiles without Node islands.
