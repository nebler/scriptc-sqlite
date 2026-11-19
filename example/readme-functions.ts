// The SQL-function forms README.md shows, built and run by run.sh: an
// unannotated function and aggregate step, and the two typed rest shapes.
import { DatabaseSync, type SQLOutputValue } from "scriptc-sqlite";

const db = new DatabaseSync(":memory:");
db.exec("create table notes (title text, n integer); insert into notes values ('Hello World', 2), ('Second Note', 3)");
db.function("slugify", { deterministic: true }, (title) => String(title).toLowerCase().replaceAll(" ", "-"));
db.aggregate("product", { start: 1, step: (acc, x) => (acc as number) * (x as number) });
db.function("count_all", { varargs: true }, (...values: SQLOutputValue[]) => values.length);
db.aggregate("count_values", { start: 0, varargs: true, step: (acc: number, ...values: SQLOutputValue[]) => acc + values.length });
for (const row of db.prepare("select slugify(title) slug from notes").all()) console.log((row as { slug: string }).slug);
const r = db.prepare("select product(n) p, count_all(1, 2, 3) c, count_values(n, title) v from notes").get() as { p: number; c: number; v: number };
console.log(r.p, r.c, r.v);
db.close();
