// marks: a bookmarks tool in one small executable, with SQLite inside.
// scriptc-sqlite's demo: migrations, the typed query builder, full-text
// search (FTS5), a user SQL function, upserts and online backups.
//
//   marks add <url> <title…> [--tag <tag>]…   save a bookmark (again: update its title and tags)
//   marks find <words…>                       full-text search, best match first
//   marks list [--tag <tag>]                  everything, or one tag
//   marks tags                                tags and how often they're used
//   marks rm <id>                             delete a bookmark
//   marks stats                               counts, and bookmarks per site
//   marks export                              all bookmarks as JSON
//   marks import <file.json>                  add or update bookmarks from export's JSON
//   marks backup <file>                       a copy of the database, made while it's open
//
// The database is $MARKS_DB, or marks.db in the current folder.
import { DatabaseSync, backup, getEnv } from "scriptc-sqlite";
import { migrate } from "scriptc-sqlite/migrate";
import {
  QueryBuilder,
  count,
  eq,
  inList,
  integer,
  raw,
  same,
  table,
  text,
} from "scriptc-sqlite/query";
import { readFileSync } from "node:fs";

const marks = table("marks", {
  id: integer().primaryKey(),
  url: text().unique(),
  title: text(),
});
const tags = table("tags", {
  markId: integer("mark_id"),
  tag: text(),
});

// getEnv, not process.env, which costs scriptc programs tens of MiB.
const db = new DatabaseSync(getEnv("MARKS_DB") ?? "marks.db");
const q = new QueryBuilder(db);

migrate(db, [
  { name: "marks", run: () => q.createTable(marks).run() },
  {
    name: "tags",
    sql: `create table tags (
      mark_id integer not null references marks (id) on delete cascade,
      tag text not null,
      primary key (mark_id, tag)
    )`,
  },
  {
    // Full-text search over titles and URLs, kept in step by triggers.
    name: "search",
    sql: `
      create virtual table marks_fts using fts5(title, url, content = 'marks', content_rowid = 'id');
      create trigger marks_ai after insert on marks begin
        insert into marks_fts (rowid, title, url) values (new.id, new.title, new.url);
      end;
      create trigger marks_ad after delete on marks begin
        insert into marks_fts (marks_fts, rowid, title, url) values ('delete', old.id, old.title, old.url);
      end;
      create trigger marks_au after update on marks begin
        insert into marks_fts (marks_fts, rowid, title, url) values ('delete', old.id, old.title, old.url);
        insert into marks_fts (rowid, title, url) values (new.id, new.title, new.url);
      end;`,
  },
]);

// host('https://www.example.com/a') = 'example.com', for grouping by site.
db.function("host", { deterministic: true }, (url) => {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#:]+)/i.exec(String(url));
  return match === null ? "" : match[1]!.toLowerCase().replace(/^www\./, "");
});

/** `--tag x` options out of the arguments; the rest stays in order. */
function parse(args: string[]): { words: string[]; tagged: string[] } {
  const words: string[] = [];
  const tagged: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--tag" && i + 1 < args.length) tagged.push(args[++i]!.toLowerCase());
    else words.push(args[i]!);
  }
  return { words, tagged };
}

function tagsOf(id: number): string[] {
  return q
    .select({ tag: tags.c.tag })
    .from(tags)
    .where(eq(tags.c.markId, id))
    .orderBy(tags.c.tag)
    .all()
    .map((r) => r.tag);
}

function show(id: number, title: string, url: string): void {
  const t = tagsOf(id);
  console.log(`${String(id).padStart(3)}  ${title}${t.length > 0 ? `  [${t.join(", ")}]` : ""}`);
  console.log(`     ${url}`);
}

/** Saves a bookmark, or updates the title of the one with that URL, and
 * adds tags. Returns its id. */
function save(url: string, title: string, newTags: string[]): number {
  const row = q
    .insertInto(marks, { url, title })
    .onConflictDoUpdate([marks.c.url], [marks.c.title])
    .returning({ id: marks.c.id })
    .all()[0]!;
  if (newTags.length > 0)
    q.insertInto(tags, ...newTags.map((tag) => ({ markId: row.id, tag }))).onConflictDoNothing().run();
  return row.id;
}

type Exported = { url: string; title: string; tags: string[] };

function fail(message: string): never {
  console.error(`marks: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { words, tagged } = parse(rest);
  if (command === "add") {
    if (words.length < 2) fail("usage: marks add <url> <title…> [--tag <tag>]…");
    const id = q.transaction(() => save(words[0]!, words.slice(1).join(" "), tagged));
    console.log(`saved ${id}`);
  } else if (command === "find") {
    if (words.length === 0) fail("usage: marks find <words…>");
    // Each word as a quoted FTS5 term, so punctuation can't break the query.
    const match = words.map((w) => `"${w.replaceAll('"', '""')}"`).join(" ");
    const found = db
      .prepare(
        `select m.id, m.url, highlight(marks_fts, 0, '«', '»') title
         from marks_fts join marks m on m.id = marks_fts.rowid
         where marks_fts match ? order by bm25(marks_fts), m.id`,
      )
      .all(match) as { id: number; url: string; title: string }[];
    if (found.length === 0) console.log("nothing found");
    for (const m of found) show(m.id, m.title, m.url);
  } else if (command === "list") {
    let s = q.select({ id: marks.c.id, title: marks.c.title, url: marks.c.url }).from(marks).orderBy(marks.c.id);
    if (tagged.length > 0)
      s = s.innerJoin(tags, same(tags.c.markId, "=", marks.c.id)).where(inList(tags.c.tag, tagged));
    const rows = s.all();
    if (rows.length === 0) console.log("no bookmarks");
    for (const m of rows) show(m.id, m.title, m.url);
  } else if (command === "tags") {
    const n = count();
    for (const r of q.select({ tag: tags.c.tag, n }).from(tags).groupBy(tags.c.tag).orderBy(n, "desc").orderBy(tags.c.tag).all())
      console.log(`${String(r.n).padStart(3)}  ${r.tag}`);
  } else if (command === "rm") {
    const id = Number(words[0]);
    if (!Number.isInteger(id)) fail("usage: marks rm <id>");
    const gone = q.deleteFrom(marks).where(eq(marks.c.id, id)).returning({ title: marks.c.title }).all();
    console.log(gone.length === 0 ? `no bookmark ${id}` : `deleted ${id}: ${gone[0]!.title}`);
  } else if (command === "stats") {
    const host = raw<string>(`host(${marks.c.url.sql})`);
    const total = q.select({ n: count(), sites: raw<number>(`count(distinct ${host.sql})`) }).from(marks).first()!;
    const tagged = q.select({ n: raw<number>(`count(distinct ${tags.c.markId.sql})`) }).from(tags).first()!;
    console.log(`${total.n} bookmarks on ${total.sites} sites, ${tagged.n} tagged`);
    const perSite = count();
    for (const r of q.select({ site: host, n: perSite }).from(marks).groupBy(host).orderBy(perSite, "desc").orderBy(host).all())
      console.log(`${String(r.n).padStart(3)}  ${r.site === "" ? "(no site)" : r.site}`);
  } else if (command === "export") {
    const all: Exported[] = q
      .select({ id: marks.c.id, url: marks.c.url, title: marks.c.title })
      .from(marks)
      .orderBy(marks.c.id)
      .all()
      .map((m) => ({ url: m.url, title: m.title, tags: tagsOf(m.id) }));
    console.log(JSON.stringify(all, null, 2));
  } else if (command === "import") {
    if (words.length !== 1) fail("usage: marks import <file.json>");
    const items = JSON.parse(readFileSync(words[0]!, "utf8")) as Exported[];
    const n = q.transaction(() => {
      for (const item of items) save(item.url, item.title, item.tags.map((t) => t.toLowerCase()));
      return items.length;
    });
    console.log(`imported ${n}`);
  } else if (command === "backup") {
    if (words.length !== 1) fail("usage: marks backup <file>");
    await backup(db, words[0]!);
    const copy = new DatabaseSync(words[0]!, { readOnly: true });
    const n = (copy.prepare("select count(*) n from marks").get() as { n: number }).n;
    copy.close();
    console.log(`backed up ${n} bookmarks to ${words[0]}`);
  } else {
    console.log("usage: marks add | find | list | tags | rm | stats | export | import | backup  (see the top of marks.ts)");
  }
  db.close();
}

await main();
