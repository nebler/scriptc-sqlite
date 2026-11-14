// scriptc only (it reads a count Node's node:sqlite does not have): a
// program that prepares 200,000 statements over 1,000 distinct SQL texts
// and never closes one. Node frees forgotten statements when its garbage
// collector runs; scriptc has none, so the module keeps SQLite statements
// in a bounded pool instead. This prints how many SQLite statements exist
// at the end, which must stay at or under the pool limit (64), and the
// sanitized lane checks nothing leaks at close. The second part does the
// same for user-defined functions.
import { DatabaseSync, _userFunctionState } from "./src/sqlite.ts";

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

// User functions keep their TypeScript side in maps (scriptc has no
// garbage collector either): SQLite tells the module when it drops a
// function (replaced, or its connection closed), and an aggregate group's
// state goes when SQLite finalizes the group, also when a statement is reset
// half way. All of it must come back to zero.
const fdb = new DatabaseSync(":memory:");
fdb.exec("create table g (k integer, v integer)");
fdb.exec("with recursive n(i) as (select 1 union all select i + 1 from n where i < 300) insert into g select i % 30, i from n");
for (let i = 0; i < 10000; i++) {
  fdb.function("f", (a) => (a as number) + i);
  fdb.aggregate("agg", { start: 0, step: (acc, v) => (acc as number) + (v as number) });
}
const replaced = _userFunctionState().functions;
let ran = 0;
for (let i = 0; i < 1000; i++) {
  const it = fdb.prepare("select k, agg(v) s from g group by k").iterate();
  it.next(); // one group done, the others abandoned by return()
  it.return();
  ran++;
}
const groupsAfterReturn = _userFunctionState().groups;
for (let i = 0; i < 1000; i++) {
  const other = new DatabaseSync(":memory:");
  other.function("one", () => 1);
  other.aggregate("cnt", { start: 0, step: (acc) => (acc as number) + 1 });
  other.prepare("select one() o, cnt() c").get();
  other.close();
}
// Node 24 loses this exception (no rows instead); here it is thrown.
fdb.aggregate("failing", {
  start: 0,
  step: (acc, v) => {
    if (v === 5) throw new Error("step failed on 5");
    return (acc as number) + (v as number);
  },
  result: (acc) => acc,
});
let failure = "no error";
try {
  fdb.prepare("select failing(v) s from g").all();
} catch (error) {
  failure = (error as Error).message;
}
fdb.close();
const end = _userFunctionState();
const ok = replaced === 2 && groupsAfterReturn === 0 && end.functions === 0 && end.groups === 0 && failure === "step failed on 5";
console.log(
  `functions: after 10,000 redefinitions ${replaced}, groups after ${ran} abandoned queries ${groupsAfterReturn}, ` +
    `after closing ${end.functions} functions and ${end.groups} groups, failing step: ${failure}, ${ok ? "functions ok" : "FUNCTIONS LEAK"}`,
);
