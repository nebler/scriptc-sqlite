// The example from README.md, built by run.sh so the README stays true.
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
