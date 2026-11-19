// Fetch the same pinned amalgamation as build.sh, without building its archives.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
process.chdir(root);
function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.error) throw r.error;
  if (r.status !== 0) process.exit(r.status ?? 1);
}
mkdirSync("build/dl", { recursive: true });
const zip = "build/dl/sqlite-amalgamation-3540100.zip";
if (!existsSync(zip)) {
  run("curl", ["-fsSL", "https://sqlite.org/2026/sqlite-amalgamation-3540100.zip", "-o", `${zip}.part`]);
  renameSync(`${zip}.part`, zip);
}
const hash = createHash("sha3-256").update(readFileSync(zip)).digest("hex");
if (hash !== "92281c86e2957f9b9305890f9ac04204caa7b677cc868dc326d942689df28e30") {
  throw new Error(`SQLite amalgamation checksum mismatch: ${hash}`);
}
run("unzip", ["-q", "-o", zip, "-d", "build/dl"]);
run("goose", ["build", "bench/goose/main.goose", "-o", process.argv[2] ?? "build/bench/goose-bench"]);
