// scriptc only (it reads a count Node's node:sqlite does not have): a
// program that prepares 200,000 statements over 1,000 distinct SQL texts
// and never closes one. Node frees forgotten statements when its garbage
// collector runs; scriptc has none, so the module keeps SQLite statements
// in a bounded pool instead. This prints how many SQLite statements exist
// at the end, which must stay at or under the pool limit (64), and the
// sanitized lane checks nothing leaks at close.
import { DatabaseSync } from "./src/sqlite.ts";

const db = new DatabaseSync(":memory:");
db.exec("create table t (k integer primary key, v text)");
db.exec("with recursive n(i) as (select 1 union all select i + 1 from n where i < 1000) insert into t (v) select 'value ' || i from n");
let total = 0;
let most = 0;
for (let i = 0; i < 200000; i++) {
  const k = (i * 7919) % 1000;
  const row = db.prepare(`select length(v) n from t where k = ${k + 1}`).get();
  if (row !== undefined) total += row["n"] as number;
  const now = db._statementCount();
  if (now > most) most = now;
}
console.log(`total ${total}, SQLite statements at the end ${db._statementCount()}, at most ${most}`);
db.close();
console.log(`after close ${db.isOpen}`);
