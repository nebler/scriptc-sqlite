# links: a web backend in one native binary

A small link service: [Hono](https://hono.dev) for routing, scriptc-sqlite for storage (SQLite compiled in, full-text search with FTS5), compiled by scriptc into one executable of about 6 MB. No Node.js at run time.

```console
$ npm install && npm run build      # → build/links
$ ./build/links                     # http://localhost:8787
```

| Route | What it does |
|---|---|
| `GET /` | a page with live stats, search, an add form and a benchmark button |
| `GET /api/stats` | this process: time from start to listening, resident memory, requests, rows |
| `GET /api/links?q=native sql` | full-text search (prefix match per word), or the latest links without `q` |
| `POST /api/links` | add `{ "url": "https://…", "title": "…" }` |
| `GET /r/:id` | redirect to a link and count the click |
| `GET /api/bench?n=100000` | inserts and reads `n` rows in memory through `run()`/`iterate()` and through `runMany()`/`forEach()`, timed in this process |

Environment: `PORT` (default 8787), `DB_PATH` (default `links.db`), `SEED_DB` (a database file copied to `DB_PATH` when that doesn't exist yet). `./build/links --seed seed.db` writes a database with 20,000 sample links and exits.

## On Vercel

`Dockerfile` builds the binary from this repository at a commit (`--build-arg REF=…`) and ships it alone on `debian:trixie-slim` with a seeded database, for Vercel's container runtime. Functions there are stateless: each instance starts from the seeded copy in `/tmp`, so links you add live only as long as that instance.

## Things scriptc needed

- **Hono's default router doesn't run yet** (`RegExpRouter` calls `.slice` on a regex match, which scriptc 0.4.12 can't compile; requests fail with 500). `hono/quick` and `hono/tiny` work.
- **Type a row parameter as `Columns`** (`import type { Columns } from "scriptc-sqlite"`). A structural type such as `{ number(i: number): number }` passes the type checker but fails when called.
- **`getEnv`**, not `process.env`, which costs scriptc programs tens of MiB.
