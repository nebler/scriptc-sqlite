// A to-do list: your starting point. Build with `npm run build`, run
// ./build/app. The database is $TODO_DB, or todo.db here.
//
//   app add <text…>    app done <id>    app list    app clear
import { DatabaseSync, getEnv } from "scriptc-sqlite";
import { migrate } from "scriptc-sqlite/migrate";
import { QueryBuilder, eq, integer, table, text } from "scriptc-sqlite/query";

const todos = table("todos", {
  id: integer().primaryKey(),
  text: text(),
  done: integer().defaultTo(0),
});

// getEnv, not process.env, which costs scriptc programs tens of MiB.
const db = new DatabaseSync(getEnv("TODO_DB") ?? "todo.db");
const q = new QueryBuilder(db);
// Add a migration to the end of this list whenever the tables change;
// never edit one that has run.
migrate(db, [{ name: "create todos", run: () => q.createTable(todos).run() }]);

const [command, ...words] = process.argv.slice(2);
if (command === "add" && words.length > 0) {
  const id = q.insertInto(todos, { text: words.join(" ") }).run().lastInsertRowid;
  console.log(`added ${id}`);
} else if (command === "done" && words.length === 1) {
  const changed = q.update(todos, { done: 1 }).where(eq(todos.c.id, Number(words[0]))).run().changes;
  console.log(changed === 1 ? `done ${words[0]}` : `no to-do ${words[0]}`);
} else if (command === "list") {
  for (const t of q.selectAll(todos).orderBy(todos.c.id).all()) console.log(`${t.done === 1 ? "[x]" : "[ ]"} ${t.id}  ${t.text}`);
} else if (command === "clear") {
  console.log(`cleared ${q.deleteFrom(todos).where(eq(todos.c.done, 1)).run().changes}`);
} else {
  console.log("usage: app add <text…> | done <id> | list | clear");
}
db.close();
