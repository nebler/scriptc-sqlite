# Benchmarks

The same SQLite workloads in seven forms, so the scriptc build can be compared with the usual alternatives:

| implementation | code | SQLite |
|---|---|---|
| scriptc | `sqlite-bench.mts`, compiled with `bin/scriptc-sqlite.mjs` | compiled in by `build.sh` |
| scriptc (packed reads) | the same binary with `SCRIPTC_SQLITE_ROW_READS=packed` (one FFI call per row that copies the whole row into a buffer; measured slower than the default per-value reads) | same |
| scriptc (typed reads) | the same binary with a `typed` argument: `startup`, `read` and `text` read through `map()`/`forEach()` and typed column getters instead of row objects (this package's extension, not in `node:sqlite`); `insert` and `udf` are the same as `scriptc` | same |
| Node | `sqlite-bench.mts` under Node 24 (`node:sqlite`) | bundled with Node |
| Deno | `sqlite-bench.mts` under Deno 2 (`node:sqlite`, through the package's `#sqlite` import) | bundled with Deno |
| Bun | `bun-bench.ts` (`bun:sqlite`) | bundled on Linux; **the system's SQLite on macOS** |
| Go | `go/` (`database/sql` + mattn/go-sqlite3 1.14.32, cgo) | compiled in by the module |
| Rust | `rust/` (rusqlite 0.37 with `bundled` and `functions`) | compiled in by libsqlite3-sys |

## Workloads

Every run is a whole process: start the program, do the work, exit. Each prints one checksum line, made only of integers, and the harness checks that all implementations print the same thing.

| workload | what it does | default N |
|---|---|---|
| `startup` | open a small database read-only, one aggregate query over 100 rows, exit: the whole life of a small command-line tool | — |
| `insert` | create a table in a fresh file database (WAL, `synchronous = normal`), insert N rows with one prepared statement in one transaction, read back count and sums | 1,000,000 |
| `read` | read N rows (integer, real, ~100-character text) and add them up in the program, not in SQL | 1,000,000 |
| `text` | read N rows of 1 KB text and a 4 KB blob, add up lengths and a few bytes of each blob | 100,000 |
| `udf` | define `twice(x)` as a user function, run `select sum(twice(n))` over N rows | 1,000,000 |

`version` prints the SQLite version (the harness reports it). The inputs are built once with Node's `node:sqlite` into `build/bench/data/`.

## Running

Needs Node 24, `npm ci` (scriptc), and clang (scriptc links with it; it also builds `tools/peakrss.c`). Bun, Deno, Go and Rust are optional: a missing one is skipped with a note. `bench/mise.toml` pins the versions used in CI (`cd bench && mise install`).

```console
$ node bench/run.mjs                     # all, 15 timed runs after 2 warm-ups each
$ node bench/run.mjs --runs=5 --only=scriptc,scriptc-packed,node --workloads=read,text
$ node bench/run.mjs --n=read=200000     # change N per workload
$ node bench/run.mjs --check             # small N, one run each, checksums only, no timings
```

Results go to `bench/results/<platform>.json` (every run) and `<platform>.md` (the tables). Implementation ids for `--only`: `scriptc`, `scriptc-packed`, `scriptc-typed`, `node`, `deno`, `bun`, `go`, `rust`.

In CI: Actions → Benchmark → Run workflow (`.github/workflows/bench.yml`). It runs `--check`, then the benchmark, on Linux x64, Linux arm64 and macOS arm64. The tables land in the job summary and `bench/results/` is uploaded as an artifact.

## Reading the results

- **Wall time** is measured by the harness around each process, as median and min–max over the timed runs. **Peak memory** is the process's maximum resident set (`tools/peakrss.c`). It runs every program, which adds the same small fork overhead to all of them.
- **`startup`** is mostly process start: runtime boot for Node, Deno and Bun, and dynamic loading for the native programs. The other workloads include it too; subtract `startup` to approximate the work itself.
- **Sizes:** native programs are reported as built. For scriptc, also stripped. For Node, Deno and Bun, the size of the runtime executable a program needs.
- **Shared CI runners are noisy.** Compare implementations within one run, on one machine, not across runs. For numbers to quote, run on a quiet machine with `--runs=30`.
- **No timings come from the development sandbox.** Its clock is not fit for measuring, so it only ever ran `--check`.

## Fairness caveats

- **SQLite versions and options differ.**
  - scriptc uses 3.54.1 with `build.sh`'s options: thread-safe, FTS5, JSON, math, RTREE, column metadata, session, no `load_extension`, DQS off, `-O2`.
  - Node, Deno and Bun use their bundled versions and options. On macOS, Bun uses the system SQLite.
  - mattn/go-sqlite3 1.14.32 compiles 3.50.4 with its own cgo flags.
  - rusqlite 0.37 compiles 3.50.2 with libsqlite3-sys's flags at Cargo's release `opt-level` 3.

  The harness prints each version. The sandbox run showed Node 3.54.1, Deno 3.53.2, Bun 3.53.0, Go 3.50.4 and Rust 3.50.2.
- **The APIs differ in how much they do per row.**
  - **JavaScript:** Node, Deno, Bun and scriptc build an object per row (`iterate()`).
  - **Go:** goes through `database/sql`, which converts through interfaces and copies strings and blobs.
  - **Rust:** copies text into `String` and blobs into `Vec<u8>`.

  Each is the ordinary way to use that library, not the fastest possible.
- **Text length is counted differently.** JavaScript's `.length` is free (UTF-16 units; all the text is in the Basic Multilingual Plane, so it equals the character count). Go and Rust count characters by scanning the UTF-8. This costs them a little in `read` and `text`.
- **Settings:** WAL and `synchronous = normal` are set the same way everywhere, for `insert` only. The other workloads open read-only.
- **Bun has no user-defined functions,** so its `udf` cell is `n/a`.
