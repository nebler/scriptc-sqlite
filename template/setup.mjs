// Puts scriptc-sqlite into vendor/scriptc-sqlite and installs: run once,
// before anything else (`node setup.mjs`).
//
// scriptc compiles a TypeScript package only when it is linked into the
// project (a file: dependency or a workspace), not when npm copies it into
// node_modules, so the package lives in vendor/ instead of coming from the
// registry.
//
//   SCRIPTC_SQLITE_REF=<branch, tag or commit>   what to download (default: main)
//   SCRIPTC_SQLITE_SOURCE=<path>                 link a local checkout instead
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, "vendor", "scriptc-sqlite");

function run(command, args, options = {}) {
  const r = spawnSync(command, args, { stdio: "inherit", ...options });
  if (r.status !== 0) {
    console.error(`setup: ${command} ${args.join(" ")} failed`);
    process.exit(1);
  }
}

rmSync(target, { recursive: true, force: true });
mkdirSync(dirname(target), { recursive: true });
const source = process.env.SCRIPTC_SQLITE_SOURCE;
if (source) {
  const from = resolve(source);
  if (!existsSync(join(from, "package.json"))) {
    console.error(`setup: ${from} is not a scriptc-sqlite checkout`);
    process.exit(1);
  }
  symlinkSync(from, target, "dir");
  console.log(`setup: linked ${from}`);
} else {
  const ref = process.env.SCRIPTC_SQLITE_REF || "main";
  const url = `https://codeload.github.com/nebler/scriptc-sqlite/tar.gz/${encodeURIComponent(ref)}`;
  console.log(`setup: downloading scriptc-sqlite ${ref}`);
  const response = await fetch(url);
  if (!response.ok) {
    console.error(`setup: ${url} answered ${response.status}`);
    process.exit(1);
  }
  mkdirSync(target, { recursive: true });
  const data = Buffer.from(await response.arrayBuffer());
  run("tar", ["xzf", "-", "--strip-components=1", "-C", target], { input: data, stdio: ["pipe", "inherit", "inherit"] });
}
run("npm", ["install", "--no-audit", "--no-fund"], { cwd: here, shell: process.platform === "win32" });
console.log("setup: done. Next: npm run build, then ./build/app");
