// links: a small web backend in one native binary. Hono for routing,
// scriptc-sqlite for storage (SQLite compiled in), compiled by scriptc.
//
//   GET  /                 a page with live stats, search and a benchmark
//   GET  /api/stats        this process: start-up time, memory, requests, rows
//   GET  /api/links?q=     full-text search (or the latest links)
//   POST /api/links        add a link: { "url": "...", "title": "..." }
//   GET  /r/:id            redirect to a link, counting the click
//   GET  /api/bench?n=     time the typed API and node:sqlite's API in this process
//
// PORT (default 8787) and DB_PATH (default links.db) come from the
// environment. On a stateless host the database is per instance: when
// DB_PATH doesn't exist and SEED_DB names a file, that file is copied in
// first (the container image ships one, made by `links --seed <file>` at
// build time); otherwise an empty database is seeded with sample links.
import { serve } from "@hono/node-server";
import { Hono } from "hono/quick";
import { DatabaseSync, getEnv, sqliteVersion } from "scriptc-sqlite";
import type { Columns } from "scriptc-sqlite";
import { migrate } from "scriptc-sqlite/migrate";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { page } from "./page.ts";

const started = performance.now();
const seedOnly = process.argv[2] === "--seed";
const dbPath = seedOnly ? (process.argv[3] ?? "links.db") : (getEnv("DB_PATH") ?? "links.db");
const seedFrom = getEnv("SEED_DB");
if (!seedOnly && seedFrom !== undefined && !existsSync(dbPath) && existsSync(seedFrom)) copyFileSync(seedFrom, dbPath);
const db = new DatabaseSync(dbPath);
db.exec("pragma journal_mode = wal; pragma synchronous = normal");
migrate(db, [
  {
    name: "links",
    sql: `create table links (
            id integer primary key,
            url text not null,
            title text not null,
            clicks integer not null default 0,
            created text not null default (datetime('now')));
          create virtual table links_fts using fts5(title, url, content = 'links', content_rowid = 'id');
          create trigger links_ai after insert on links begin
            insert into links_fts (rowid, title, url) values (new.id, new.title, new.url);
          end;`,
  },
]);

// Sample data for an empty database: 20,000 links in one transaction.
const SITES = ["sqlite.org", "scriptc.dev", "nodejs.org", "hono.dev", "github.com", "vercel.com", "example.com"];
const WORDS = ["fast", "native", "typescript", "sqlite", "binary", "server", "search", "compile", "memory", "start"];
let seedMs = 0;
const count = db.prepare("select count(*) from links").map((r) => r.number(0))[0]!;
if (count === 0) {
  const t = performance.now();
  db.exec("begin");
  db.prepare("insert into links (url, title) values (?, ?)").runMany(20000, (i, p) => {
    const site = SITES[i % SITES.length]!;
    p.text(0, `https://${site}/page/${i}`);
    p.text(1, `${WORDS[i % WORDS.length]} ${WORDS[(i * 7) % WORDS.length]} note ${i} on ${site}`);
  });
  db.exec("commit");
  seedMs = performance.now() - t;
}

if (seedOnly) {
  db.exec("pragma wal_checkpoint(truncate); pragma journal_mode = delete");
  db.close();
  console.log(`seeded ${dbPath} in ${seedMs.toFixed(1)} ms`);
  process.exit(0);
}

type Link = { id: number; url: string; title: string; clicks: number; created: string };
// The row parameter must be typed as Columns itself: a structural type
// such as { number(i: number): number } passes the checker but scriptc
// cannot call it (a TypeError at run time).
const readLink = (r: Columns): Link => ({
  id: r.number(0),
  url: r.text(1),
  title: r.text(2),
  clicks: r.number(3),
  created: r.text(4),
});

const latest = db.prepare("select id, url, title, clicks, created from links order by id desc limit ?");
const search = db.prepare(
  `select l.id, l.url, l.title, l.clicks, l.created from links_fts f join links l on l.id = f.rowid
   where links_fts match ? order by rank limit ?`,
);
const byId = db.prepare("select url from links where id = ?");
const click = db.prepare("update links set clicks = clicks + 1 where id = ?");
const insert = db.prepare("insert into links (url, title) values (?, ?) returning id");

// Resident memory from /proc (Linux); 0 elsewhere.
function rssMiB(): number {
  try {
    const statm = readFileSync("/proc/self/statm", "utf8").split(" ");
    return Math.round((Number(statm[1]) * 4096) / 1048576 * 10) / 10;
  } catch {
    return 0;
  }
}

let requests = 0;
let bootMs = 0;
const app = new Hono();
app.use(async (_c, next) => {
  requests++;
  await next();
});

app.get("/", (c) => c.html(page));

app.get("/api/stats", (c) =>
  c.json({
    runtime: "native binary compiled by scriptc",
    sqlite: sqliteVersion(),
    bootMs: Math.round(bootMs * 100) / 100,
    seedMs: Math.round(seedMs * 10) / 10,
    uptimeS: Math.round((performance.now() - started) / 100) / 10,
    requests,
    rssMiB: rssMiB(),
    links: db.prepare("select count(*) from links").map((r) => r.number(0))[0]!,
  }),
);

app.get("/api/links", (c) => {
  const q = (c.req.query("q") ?? "").trim();
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? "20") || 20, 1), 100);
  const t = performance.now();
  // Each word as a prefix search: "nat typ" finds "native typescript".
  const match = q
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => `"${w.replaceAll('"', "")}"*`)
    .join(" ");
  const links = match === "" ? latest.map(readLink, limit) : search.map(readLink, match, limit);
  return c.json({ ms: Math.round((performance.now() - t) * 1000) / 1000, links });
});

app.post("/api/links", async (c) => {
  const body = (await c.req.json()) as { url?: string; title?: string };
  const url = String(body.url ?? "");
  if (!/^https?:\/\//.test(url)) return c.json({ error: "url must start with http:// or https://" }, 400);
  const title = String(body.title ?? url).slice(0, 200);
  const id = insert.map((r) => r.number(0), url, title)[0]!;
  return c.json({ id, url, title }, 201);
});

app.get("/r/:id", (c) => {
  const id = Number(c.req.param("id"));
  const url = byId.map((r) => r.text(0), id)[0];
  if (url === undefined) return c.text("no such link", 404);
  click.run(id);
  return c.redirect(url, 302);
});

// The same reads and writes two ways, timed in this process.
app.get("/api/bench", (c) => {
  const n = Math.min(Math.max(Number(c.req.query("n") ?? "100000") || 100000, 1000), 200000);
  const mem = new DatabaseSync(":memory:");
  mem.exec("create table b (id integer primary key, n integer, r real, body text)");
  const add = mem.prepare("insert into b (n, r, body) values (?, ?, ?)");

  let t = performance.now();
  mem.exec("begin");
  for (let i = 0; i < n; i++) add.run(i, i * 0.5, `row ${i} of the benchmark`);
  mem.exec("rollback");
  const insertRun = performance.now() - t;

  t = performance.now();
  mem.exec("begin");
  add.runMany(n, (i, p) => {
    p.number(0, i);
    p.number(1, i * 0.5);
    p.text(2, `row ${i} of the benchmark`);
  });
  mem.exec("commit");
  const insertMany = performance.now() - t;

  type Row = { n: number; r: number; body: string };
  t = performance.now();
  let a = 0;
  for (const row of mem.prepare("select n, r, body from b").iterate()) {
    const r = row as Row;
    a += r.n + r.body.length;
  }
  const readIterate = performance.now() - t;

  t = performance.now();
  const sum = { v: 0 };
  mem.prepare("select n, r, body from b").forEach((r) => {
    sum.v += r.number(0) + r.text(2).length;
  });
  const readTyped = performance.now() - t;
  mem.close();

  const ms = (x: number) => Math.round(x * 10) / 10;
  return c.json({
    rows: n,
    checksumsAgree: a === sum.v,
    insert: { "run() in a loop": ms(insertRun), "runMany()": ms(insertMany) },
    read: { "iterate() + cast": ms(readIterate), "forEach() typed": ms(readTyped) },
  });
});

const port = Number(getEnv("PORT") ?? "8787");
serve({ fetch: app.fetch, port }, (info) => {
  // performance.now() counts from the start of the process.
  bootMs = performance.now();
  console.log(`links: listening on ${info.port}, ready ${bootMs.toFixed(1)} ms after start`);
});
