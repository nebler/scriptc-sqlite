// A tiny notes tool, built as its own project on top of scriptc-sqlite:
//   app add "text"      app list      app find word
import { DatabaseSync } from "scriptc-sqlite";

declare function exampleTag(text: string): number;

// A row read as this shape: a `type`, not an `interface`, because only a
// type can be the target of a cast from a row (TypeScript gives interfaces
// no index signature).
type Note = {
  id: number;
  body: string;
  tag: string;
};

const db = new DatabaseSync(process.env["NOTES_DB"] ?? "notes.db");
db.exec("create table if not exists notes (id integer primary key, body text not null, tag text not null)");

const [command, ...words] = process.argv.slice(2);
const text = words.join(" ");
if (command === "add") {
  const tag = exampleTag(text).toString(16).padStart(8, "0");
  const result = db.prepare("insert into notes (body, tag) values (?, ?)").run(text, tag);
  console.log(`added note ${result.lastInsertRowid} (tag ${tag})`);
} else if (command === "list" || command === "find") {
  const query = db.prepare("select id, body, tag from notes where body like ? order by id");
  for (const row of query.iterate(command === "find" ? `%${text}%` : "%")) {
    const note = row as Note;
    console.log(`${note.id}  ${note.tag}  ${note.body}`);
  }
} else {
  console.log("usage: app add <text> | app list | app find <word>");
}
db.close();
