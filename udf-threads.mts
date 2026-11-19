// User-defined functions on four worker threads at once, each thread with
// its own connection to one WAL file and its own definitions of the same
// function names, which differ by thread (a tag, a scale factor, an error
// message). Runs unchanged under Node (node:sqlite) and as a scriptc
// binary; run.sh compares the two outputs byte for byte.
//
// SQLite calls a function on the thread that steps the statement, and the
// module keeps one dispatcher and one table of functions per thread, so a
// thread must only ever see its own functions' results and its own
// exceptions. Every worker waits until all four are running, then checks
// each answer against plain SQL; only the checks' answers are printed.
import { DatabaseSync } from "#sqlite";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { mkdirSync, rmSync } from "node:fs";

interface Job {
  id: number;
  path: string;
}

const WORKERS = 4;
const ROWS = 2000;
const ROUNDS = 20;

function work(job: Job): string {
  const id = job.id;
  const db = new DatabaseSync(job.path, { timeout: 10000 });
  db.function("tag", { deterministic: true }, (x) => `w${id}:${x}`);
  db.function("scale", { deterministic: true }, (x) => (x as number) * id);
  db.function("fail", (x) => {
    if (x === 1000) throw new Error(`worker ${id} fails on ${x}`);
    return x ?? null;
  });
  db.aggregate("total", { start: 0, step: (acc, x) => (acc as number) + (x as number) * id });
  db.aggregate("moving", {
    start: 0,
    step: (acc, x) => (acc as number) + (x as number),
    inverse: (acc, x) => (acc as number) - (x as number),
  });

  // Wait until every worker has defined its functions.
  db.exec(`insert into ready values (${id})`);
  const readyCount = db.prepare("select count(*) c from ready");
  let together = false;
  for (let i = 0; i < 10000000; i++) {
    if ((readyCount.get() as { c: number }).c === WORKERS) {
      together = true;
      break;
    }
  }

  const sums = db.prepare("select sum(scale(x)) a, total(x) b, sum(x) * ? c from nums");
  const tagged = db.prepare("select tag(x) t from nums where x = ?");
  const windows = db.prepare(`
    select count(*) c from (
      select moving(x) over w m, sum(x) over w s from nums
      window w as (order by x rows between 2 preceding and current row))
    where m = s`);
  const failing = db.prepare("select sum(fail(x)) s from nums");
  let wrong = 0;
  let caught = 0;
  let foreign = 0;
  for (let round = 1; round <= ROUNDS; round++) {
    const r = sums.get(id) as { a: number; b: number; c: number };
    if (r.a !== r.c || r.b !== r.c) wrong++;
    const t = tagged.get(round) as { t: string };
    if (t.t !== `w${id}:${round}`) wrong++;
    if ((windows.get() as { c: number }).c !== ROWS) wrong++;
    try {
      failing.get();
      wrong++;
    } catch (error) {
      caught++;
      if ((error as Error).message !== `worker ${id} fails on 1000`) foreign++;
    }
  }
  db.close();
  return `worker ${id}: all ${WORKERS} running together ${together}, ${ROUNDS} rounds, wrong answers ${wrong}, exceptions caught ${caught}, from another thread ${foreign}`;
}

if (isMainThread) {
  mkdirSync("build/tmp", { recursive: true });
  const path = "build/tmp/udf-threads.db";
  for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
  const db = new DatabaseSync(path);
  db.exec("pragma journal_mode = wal");
  db.exec("create table ready (id integer primary key); create table nums (x integer primary key)");
  db.exec(`with recursive n(i) as (select 1 union all select i + 1 from n where i < ${ROWS}) insert into nums select i from n`);
  // The main thread has no functions: calling one here fails cleanly.
  try {
    db.prepare("select tag(1) t").get();
    console.log("main thread: tag() ran");
  } catch (error) {
    console.log(`main thread: ${(error as Error).message}`);
  }

  const reports: string[] = [];
  let finished = 0;
  for (let id = 1; id <= WORKERS; id++) {
    const job: Job = { id, path };
    const worker = new Worker(new URL(import.meta.url), { workerData: job });
    worker.on("message", (message: unknown) => {
      reports.push(message as string);
    });
    worker.on("error", (error: Error) => {
      reports.push(`worker ${id} failed: ${error.message}`);
    });
    worker.on("exit", () => {
      finished++;
      if (finished === WORKERS) {
        reports.sort();
        for (const line of reports) console.log(line);
        db.close();
        for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
      }
    });
  }
} else {
  const job = workerData as Job;
  parentPort!.postMessage(work(job));
}
