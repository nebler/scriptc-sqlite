#!/usr/bin/env node
// The benchmark harness: builds the implementations, prepares the input
// databases once, runs every implementation × workload, and writes
// bench/results/<platform>.json and .md (see bench/README.md).
//
//   node bench/run.mjs                      everything, 15 runs after 2 warm-ups
//   node bench/run.mjs --runs=5 --only=scriptc,node --workloads=read,udf
//   node bench/run.mjs --n=read=200000,text=20000
//   node bench/run.mjs --check              small inputs, one run each, checksums only
//
// --check prints no timings: it is the correctness check, meant for any
// machine, including ones whose clock is not fit for measuring.
//
// Needs Node 24 (it prepares the inputs with node:sqlite). Implementations
// whose toolchain is missing are skipped with a note.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const work = join(root, "build", "bench");
const data = join(work, "data");
const tmp = join(work, "tmp");

// ── options ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name) => {
  const a = args.find((x) => x === `--${name}` || x.startsWith(`--${name}=`));
  if (a === undefined) return undefined;
  return a.includes("=") ? a.slice(a.indexOf("=") + 1) : "";
};
for (const a of args) {
  if (!/^--(check|runs|warmups|only|workloads|n|no-build)(=|$)/.test(a)) {
    console.error(`run.mjs: unknown argument ${a}`);
    process.exit(2);
  }
}
const check = flag("check") !== undefined;
const runs = check ? 1 : Number(flag("runs") ?? 15);
const warmups = check ? 0 : Number(flag("warmups") ?? 2);
const only = flag("only")?.split(",").filter(Boolean);
const ALL_WORKLOADS = ["startup", "insert", "read", "text", "udf"];
const workloads = flag("workloads")?.split(",").filter(Boolean) ?? ALL_WORKLOADS;
for (const w of workloads) if (!ALL_WORKLOADS.includes(w)) throw new Error(`unknown workload ${w}`);
const sizes = check
  ? { startup: 1000, insert: 2000, read: 2000, text: 200, udf: 2000 }
  : { startup: 1000, insert: 1_000_000, read: 1_000_000, text: 100_000, udf: 1_000_000 };
for (const pair of (flag("n") ?? "").split(",").filter(Boolean)) {
  const [w, v] = pair.split("=");
  if (!(w in sizes) || !(Number(v) > 0)) throw new Error(`bad --n entry ${pair}`);
  sizes[w] = Number(v);
}

// ── helpers ──────────────────────────────────────────────────────────────
function run(cmd, cmdArgs, options = {}) {
  return spawnSync(cmd, cmdArgs, { encoding: "utf8", maxBuffer: 64 << 20, ...options });
}

function found(cmd) {
  const r = run(cmd, ["--version"]);
  return r.error === undefined && r.status === 0;
}

function firstLine(text) {
  return (text ?? "").trim().split("\n")[0] ?? "";
}

function whichPath(cmd) {
  const r = run("sh", ["-c", `command -v ${cmd}`]);
  return r.status === 0 ? realpathSync(r.stdout.trim()) : null;
}

function fileSize(path) {
  return path !== null && existsSync(path) ? statSync(path).size : null;
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

// ── implementations ──────────────────────────────────────────────────────
const tsBench = join(root, "bench", "sqlite-bench.mts");
const scriptcExe = join(work, "scriptc-bench");
const gooseExe = join(work, "goose-bench");
const goExe = join(work, "go-bench");
const rustTarget = join(work, "rust-target");
const rustExe = join(rustTarget, "release", "rust-bench");
const notes = [];

/** Each implementation: how to build it, how to run one workload. */
const impls = [
  {
    id: "scriptc",
    label: "scriptc",
    available: () => found("clang"),
    missing: "clang (scriptc links with it)",
    build() {
      const r = run(process.execPath, [join(root, "bin", "scriptc-sqlite.mjs"), "build", tsBench, "-o", scriptcExe], { cwd: root });
      if (r.status !== 0) return `scriptc build failed:\n${(r.stdout + r.stderr).slice(-2000)}`;
      return null;
    },
    command: (w, db, n) => [scriptcExe, [w, db, String(n)], {}],
    version: () => firstLine(run(join(root, "node_modules", ".bin", "scriptc"), ["--version"]).stdout),
    size: () => {
      const stripped = `${scriptcExe}-stripped`;
      copyFileSync(scriptcExe, stripped);
      const s = run("strip", [stripped]);
      return { bytes: fileSize(scriptcExe), stripped: s.status === 0 ? fileSize(stripped) : null, what: "program" };
    },
  },
  {
    id: "scriptc-packed",
    label: "scriptc (packed reads)",
    available: () => found("clang"),
    missing: "clang",
    build: () => (existsSync(scriptcExe) ? null : "needs the scriptc build"),
    command: (w, db, n) => [scriptcExe, [w, db, String(n)], { SCRIPTC_SQLITE_ROW_READS: "packed" }],
    version: () => "same binary, SCRIPTC_SQLITE_ROW_READS=packed",
    size: () => null,
  },
  {
    id: "scriptc-typed",
    label: "scriptc (typed API)",
    available: () => found("clang"),
    missing: "clang",
    build: () => (existsSync(scriptcExe) ? null : "needs the scriptc build"),
    command: (w, db, n) => [scriptcExe, [w, db, String(n), "typed"], {}],
    version: () => "same binary: map/forEach, runMany, numberFunction",
    size: () => null,
  },
  {
    id: "node",
    label: "Node (node:sqlite)",
    available: () => true,
    build: () => null,
    command: (w, db, n) => [process.execPath, [tsBench, w, db, String(n)], {}],
    version: () => process.version,
    size: () => ({ bytes: fileSize(realpathSync(process.execPath)), stripped: null, what: "runtime" }),
  },
  {
    id: "deno",
    label: "Deno (node:sqlite)",
    available: () => found("deno"),
    missing: "deno",
    build: () => null,
    command: (w, db, n) => ["deno", ["run", "--allow-read", "--allow-write", "--allow-env", tsBench, w, db, String(n)], {}],
    version: () => firstLine(run("deno", ["--version"]).stdout),
    size: () => ({ bytes: fileSize(whichPath("deno")), stripped: null, what: "runtime" }),
  },
  {
    id: "bun",
    label: "Bun (bun:sqlite)",
    available: () => found("bun"),
    missing: "bun",
    build: () => null,
    command: (w, db, n) => ["bun", [join(root, "bench", "bun-bench.ts"), w, db, String(n)], {}],
    version: () => `bun ${firstLine(run("bun", ["--version"]).stdout)}`,
    size: () => ({ bytes: fileSize(whichPath("bun")), stripped: null, what: "runtime" }),
  },
  {
    id: "go",
    label: "Go (mattn/go-sqlite3)",
    available: () => run("go", ["version"]).status === 0,
    missing: "go",
    build() {
      const r = run("go", ["build", "-o", goExe, "."], { cwd: join(root, "bench", "go"), env: { ...process.env, CGO_ENABLED: "1" } });
      return r.status === 0 ? null : `go build failed:\n${(r.stdout + r.stderr).slice(-2000)}`;
    },
    command: (w, db, n) => [goExe, [w, db, String(n)], {}],
    version: () => firstLine(run("go", ["version"]).stdout),
    size: () => ({ bytes: fileSize(goExe), stripped: null, what: "program" }),
  },
  {
    id: "goose",
    label: "Goose",
    available: () => found("goose"),
    missing: "goose",
    build() {
      const r = run(process.execPath, [join(root, "bench", "goose", "build.mjs"), gooseExe], { cwd: root });
      return r.status === 0 ? null : `goose build failed:\n${(r.stdout + r.stderr).slice(-4000)}`;
    },
    command: (w, db, n) => [gooseExe, [w, db, String(n)], {}],
    version: () => firstLine(run("goose", ["--version"]).stdout),
    size: () => ({ bytes: fileSize(gooseExe), stripped: null, what: "program" }),
  },
  {
    id: "rust",
    label: "Rust (rusqlite, bundled)",
    available: () => found("cargo"),
    missing: "cargo",
    build() {
      const r = run("cargo", ["build", "--release", "--locked", "--target-dir", rustTarget], { cwd: join(root, "bench", "rust") });
      return r.status === 0 ? null : `cargo build failed:\n${(r.stdout + r.stderr).slice(-2000)}`;
    },
    command: (w, db, n) => [rustExe, [w, db, String(n)], {}],
    version: () => firstLine(run("rustc", ["--version"]).stdout),
    size: () => ({ bytes: fileSize(rustExe), stripped: null, what: "program" }),
  },
].filter((impl) => only === undefined || only.includes(impl.id));

// ── inputs ───────────────────────────────────────────────────────────────
mkdirSync(data, { recursive: true });
mkdirSync(tmp, { recursive: true });
const FILLER = "ünïcødé ✓ the quick brown fox jumps over the lazy dog 0123456789 abcdefghijklmnop";
const { DatabaseSync } = await import("node:sqlite");

function prepare(name, fill) {
  const path = join(data, name);
  if (existsSync(path)) return path;
  const part = `${path}.part`;
  rmSync(part, { force: true });
  const db = new DatabaseSync(part);
  db.exec("begin");
  fill(db);
  db.exec("commit");
  db.close();
  copyFileSync(part, path);
  rmSync(part, { force: true });
  return path;
}

const inputs = {
  startup: () =>
    prepare("startup.db", (db) => {
      db.exec("create table notes (id integer primary key, body text)");
      const add = db.prepare("insert into notes (body) values (?)");
      for (let i = 1; i <= 1000; i++) add.run(`note ${i} ${FILLER}`);
    }),
  read: (n) =>
    prepare(`read-${n}.db`, (db) => {
      db.exec("create table t (id integer primary key, n integer, r real, body text)");
      const add = db.prepare("insert into t (n, r, body) values (?, ?, ?)");
      for (let i = 1; i <= n; i++) add.run(i, i * 0.5, `row ${i} ${FILLER}`);
    }),
  text: (n) =>
    prepare(`text-${n}.db`, (db) => {
      db.exec("create table t2 (id integer primary key, body text, data blob)");
      const add = db.prepare("insert into t2 (body, data) values (?, ?)");
      const alphabet = "abcdefghijklmnopqrstuvwxyz";
      const blob = new Uint8Array(4096);
      for (let i = 1; i <= n; i++) {
        for (let j = 0; j < blob.length; j++) blob[j] = (i + j) & 255;
        add.run(`text row ${i} `.padEnd(1024, alphabet), blob);
      }
    }),
};

/** The database path and N a workload runs on; insert gets a fresh file. */
function target(workload, impl) {
  if (workload === "startup") return { db: inputs.startup(), n: 0 };
  if (workload === "insert") {
    const db = join(tmp, `insert-${impl.id}.db`);
    return { db, n: sizes.insert, fresh: true };
  }
  if (workload === "text") return { db: inputs.text(sizes.text), n: sizes.text };
  return { db: inputs.read(sizes[workload]), n: sizes[workload] };
}

// ── build ────────────────────────────────────────────────────────────────
const peakrss = join(work, "peakrss");
{
  const cc = ["cc", "clang"].find((c) => found(c));
  if (cc === undefined) throw new Error("run.mjs needs cc or clang to build tools/peakrss.c");
  const r = run(cc, ["-O2", "-o", peakrss, join(root, "tools", "peakrss.c")]);
  if (r.status !== 0) throw new Error(`building peakrss failed: ${r.stderr}`);
}

const ready = [];
for (const impl of impls) {
  if (!impl.available()) {
    notes.push(`${impl.label}: skipped, ${impl.missing} not found`);
    continue;
  }
  if (flag("no-build") === undefined || impl.id === "scriptc-packed" || impl.id === "scriptc-typed") {
    process.stderr.write(`building ${impl.label}\n`);
    const error = impl.build();
    if (error !== null) {
      notes.push(`${impl.label}: skipped, ${error.split("\n")[0]}`);
      process.stderr.write(`${error}\n`);
      continue;
    }
  }
  ready.push(impl);
}

// ── run ──────────────────────────────────────────────────────────────────
/** One run: wall time (ns), peak RSS (KiB), checksum line. */
function once(impl, workload) {
  const t = target(workload, impl);
  if (t.fresh) for (const s of ["", "-wal", "-shm"]) rmSync(t.db + s, { force: true });
  const [cmd, cmdArgs, env] = impl.command(workload, t.db, t.n);
  const start = process.hrtime.bigint();
  const r = run(peakrss, [cmd, ...cmdArgs], { env: { ...process.env, ...env } });
  const ns = Number(process.hrtime.bigint() - start);
  const rss = Number(/peak-rss-kib (\d+)/.exec(r.stderr ?? "")?.[1] ?? NaN);
  if (r.status !== 0) return { error: `exit ${r.status}: ${firstLine(r.stderr.replace(/^peak-rss-kib.*$/m, ""))}` };
  return { ns, rss, out: firstLine(r.stdout) };
}

const results = {};
const versions = {};
for (const impl of ready) {
  const t = run(peakrss, [...(() => {
    const [cmd, cmdArgs] = impl.command("version", join(tmp, "version.db"), 0);
    return [cmd, ...cmdArgs];
  })()], { env: { ...process.env, ...impl.command("version", "", 0)[2] } });
  versions[impl.id] = { runtime: impl.version(), sqlite: firstLine(t.stdout) || "?" };
  results[impl.id] = {};
  for (const workload of workloads) {
    process.stderr.write(`${impl.label}: ${workload}\n`);
    const first = once(impl, workload);
    if (first.error !== undefined) {
      results[impl.id][workload] = { error: first.error };
      continue;
    }
    if (first.out === "n/a") {
      results[impl.id][workload] = { na: true };
      continue;
    }
    const times = [];
    const rss = [];
    let error;
    for (let i = 0; i < warmups + runs; i++) {
      const r = i === 0 ? first : once(impl, workload);
      if (r.error !== undefined || r.out !== first.out) {
        error = r.error ?? `checksum changed between runs: ${r.out}`;
        break;
      }
      if (i >= warmups || warmups === 0) {
        times.push(r.ns / 1e6);
        rss.push(r.rss / 1024);
      }
    }
    results[impl.id][workload] = error !== undefined ? { error } : { checksum: first.out, ms: times, rssMiB: rss };
  }
}

// ── checksums ────────────────────────────────────────────────────────────
const agreement = {};
let mismatch = false;
for (const workload of workloads) {
  const outs = new Map();
  for (const impl of ready) {
    const r = results[impl.id][workload];
    if (r?.checksum !== undefined) outs.set(impl.id, r.checksum);
  }
  const distinct = new Set(outs.values());
  agreement[workload] = { agree: distinct.size <= 1, checksums: Object.fromEntries(outs) };
  if (distinct.size > 1) mismatch = true;
  for (const impl of ready) if (results[impl.id][workload]?.error !== undefined) mismatch = true;
}

// ── report ───────────────────────────────────────────────────────────────
const machine = {
  platform: `${os.platform()}-${os.arch()}`,
  os: `${os.type()} ${os.release()}`,
  cpu: os.cpus()[0]?.model ?? "?",
  cores: os.cpus().length,
  memoryGiB: Math.round(os.totalmem() / 2 ** 30),
};
const cell = (r, pick) => {
  if (r === undefined) return "—";
  if (r.na) return "n/a";
  if (r.error !== undefined) return "error";
  return pick(r);
};
const fmt = (x) => (x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2));
const lines = [];
const table = (head, rows) => {
  lines.push(`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`);
  for (const row of rows) lines.push(`| ${row.join(" | ")} |`);
  lines.push("");
};

if (check) {
  lines.push(`# Benchmark check: ${machine.platform}`, "", "Small inputs, one run each, checksums only (no timings).", "");
  table(["workload", "N", ...ready.map((i) => i.label), "agree"], workloads.map((w) => [
    w,
    String(sizes[w]),
    ...ready.map((i) => cell(results[i.id][w], (r) => `\`${r.checksum}\``)),
    agreement[w].agree && ready.every((i) => results[i.id][w]?.error === undefined) ? "yes" : "**NO**",
  ]));
} else {
  lines.push(`# Benchmark: ${machine.platform}`, "");
  lines.push(`${machine.cpu}, ${machine.cores} cores, ${machine.memoryGiB} GiB, ${machine.os}. ${runs} runs per cell after ${warmups} warm-ups; every run is a whole process (start-up included).`, "");
  lines.push("**Wall time, median ms (min–max)**", "");
  table(["implementation", ...workloads.map((w) => `${w}${sizes[w] && w !== "startup" ? ` (${sizes[w].toLocaleString("en")})` : ""}`)],
    ready.map((i) => [i.label, ...workloads.map((w) => cell(results[i.id][w], (r) => `${fmt(median(r.ms))} (${fmt(Math.min(...r.ms))}–${fmt(Math.max(...r.ms))})`))]));
  lines.push("**Peak memory, median MiB**", "");
  table(["implementation", ...workloads], ready.map((i) => [i.label, ...workloads.map((w) => cell(results[i.id][w], (r) => fmt(median(r.rssMiB))))]));
  lines.push(`**Checksums:** ${workloads.map((w) => `${w} ${agreement[w].agree ? "agree" : "DIFFER"}`).join(", ")}.`, "");
}
lines.push("**Sizes and versions**", "");
table(["implementation", "runtime or toolchain", "SQLite", "executable"], ready.map((i) => {
  const s = i.size();
  const size = s === null ? "—" : `${(s.bytes / 1e6).toFixed(1)} MB ${s.what}${s.stripped ? ` (${(s.stripped / 1e6).toFixed(1)} MB stripped)` : ""}`;
  return [i.label, versions[i.id].runtime, versions[i.id].sqlite, size];
}));
for (const w of workloads) for (const i of ready) if (results[i.id][w]?.error !== undefined) notes.push(`${i.label}, ${w}: ${results[i.id][w].error}`);
if (notes.length > 0) {
  lines.push("**Notes**", "");
  for (const n of notes) lines.push(`- ${n}`);
  lines.push("");
}
const markdown = lines.join("\n");
console.log(markdown);

if (!check) {
  const out = join(root, "bench", "results");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${machine.platform}.json`), JSON.stringify({ machine, runs, warmups, sizes, versions, results, agreement, notes }, null, 2) + "\n");
  writeFileSync(join(out, `${machine.platform}.md`), markdown + "\n");
}
process.exit(mismatch ? 1 : 0);
