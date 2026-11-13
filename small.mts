// A small, ordinary use, for a memory figure that test.mts (with its 1 MB
// blob and 300,000-character strings) does not give: a file database, a
// table, 1,000 rows written in one transaction, read back and summed.
import { DatabaseSync } from "#sqlite";
import { mkdirSync, rmSync } from "node:fs";

mkdirSync("build/tmp", { recursive: true });
const path = "build/tmp/small.db";
rmSync(path, { force: true });

const db = new DatabaseSync(path);
db.exec("pragma journal_mode = wal; create table notes (id integer primary key, title text, body text, score real)");
const add = db.prepare("insert into notes (title, body, score) values (?, ?, ?)");
db.exec("begin");
for (let i = 0; i < 1000; i++) add.run(`note ${i}`, `Body of note ${i}: ünïcødé and 🙂`, i / 7);
db.exec("commit");
db.close();

const again = new DatabaseSync(path, { readOnly: true });
const rows = again.prepare("select title, body, score from notes where id % 3 = 0 order by id").all();
let total = 0;
let chars = 0;
for (const row of rows) {
  total += row["score"] as number;
  chars += (row["body"] as string).length;
}
console.log(`rows ${rows.length}, score total ${total.toFixed(6)}, body chars ${chars}`);
console.log(`last ${JSON.stringify(rows[rows.length - 1]!["title"])}`);
again.close();
rmSync(path, { force: true });
rmSync(`${path}-wal`, { force: true });
rmSync(`${path}-shm`, { force: true });
