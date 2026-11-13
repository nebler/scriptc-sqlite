// Worker threads, each with its own connection to one file database in WAL
// mode: two writers add rows in transactions of 50 while two readers keep
// counting. Runs unchanged under Node (node:sqlite) and as a scriptc binary;
// run.sh compares the two outputs byte for byte.
//
// What each reader checks on every read: it never sees half a transaction
// (the count is a multiple of 50, and sum(n) equals the count), and the
// count never goes down. The interleaving differs from run to run, so only
// the checks' answers are printed, not the counts seen.
import { DatabaseSync } from "#sqlite";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { mkdirSync, rmSync } from "node:fs";

interface Job {
  role: string;
  id: number;
  path: string;
}

const WRITERS = 2;
const READERS = 2;
const BATCHES = 10;
const BATCH = 50;

function writer(job: Job): string {
  const db = new DatabaseSync(job.path, { timeout: 10000 });
  const add = db.prepare("insert into items (worker, n, label, data) values (?, 1, ?, ?)");
  for (let b = 0; b < BATCHES; b++) {
    db.exec("begin immediate");
    for (let i = 0; i < BATCH; i++) {
      const k = b * BATCH + i;
      add.run(job.id, `w${job.id}·${k} ✓`, new Uint8Array([job.id, k & 255, k >> 8]));
    }
    db.exec("commit");
  }
  db.close();
  return `writer ${job.id}: ${BATCHES} transactions of ${BATCH}`;
}

function reader(job: Job): string {
  const db = new DatabaseSync(job.path, { timeout: 10000, readOnly: true });
  const count = db.prepare("select count(*) c, coalesce(sum(n), 0) s from items");
  let reads = 0;
  let torn = 0;
  let backwards = 0;
  let last = 0;
  // Read until both writers are done (the count reaches the total), and at
  // least 20 times.
  const total = WRITERS * BATCHES * BATCH;
  while (reads < 20 || last < total) {
    const row = count.get() as { c: number; s: number };
    const c = row.c;
    const s = row.s;
    if (c % BATCH !== 0 || s !== c) torn++;
    if (c < last) backwards++;
    last = c;
    reads++;
    if (reads > 1000000) break;
  }
  db.close();
  return `reader ${job.id}: torn reads ${torn}, count went down ${backwards} times, final count ${last}`;
}

if (isMainThread) {
  mkdirSync("build/tmp", { recursive: true });
  const path = "build/tmp/threads.db";
  for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
  const db = new DatabaseSync(path);
  db.exec("pragma journal_mode = wal");
  db.exec("create table items (id integer primary key, worker integer, n integer, label text, data blob)");

  const jobs: Job[] = [];
  for (let i = 1; i <= WRITERS; i++) jobs.push({ role: "writer", id: i, path });
  for (let i = 1; i <= READERS; i++) jobs.push({ role: "reader", id: i, path });
  const reports: string[] = [];
  let finished = 0;
  for (const job of jobs) {
    const worker = new Worker(new URL(import.meta.url), { workerData: job });
    worker.on("message", (message: unknown) => {
      reports.push(message as string);
    });
    worker.on("error", (error: Error) => {
      reports.push(`${job.role} ${job.id} failed: ${error.message}`);
    });
    worker.on("exit", () => {
      finished++;
      if (finished === jobs.length) {
        reports.sort();
        for (const line of reports) console.log(line);
        const summary = db.prepare("select worker, count(*) c, sum(n) s, min(label) lo, max(label) hi, sum(length(data)) bytes from items group by worker order by worker").all();
        for (const row of summary) {
          const r = row as { worker: number; c: number; s: number; lo: string; hi: string; bytes: number };
          console.log(`worker ${r.worker}: rows ${r.c}, sum ${r.s}, labels ${JSON.stringify(r.lo)}..${JSON.stringify(r.hi)}, blob bytes ${r.bytes}`);
        }
        const check = db.prepare("select count(*) c, count(distinct label) d from items").get() as { c: number; d: number };
        console.log(`total rows ${check.c}, distinct labels ${check.d}, in transaction ${db.isTransaction}`);
        db.close();
        for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
      }
    });
  }
} else {
  const job = workerData as Job;
  parentPort!.postMessage(job.role === "writer" ? writer(job) : reader(job));
}
