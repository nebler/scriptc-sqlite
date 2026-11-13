#!/usr/bin/env node
// scriptc-sqlite: runs scriptc with SQLite linked in.
//
//   scriptc-sqlite build app.ts -o app             (any scriptc command and options)
//   scriptc-sqlite build app.ts --ffi mine.json -o app   (your own FFI too)
//   scriptc-sqlite manifest [--sanitize] [--ffi mine.json]  (print a manifest path)
//
// scriptc takes one FFI manifest per build, and library builds cannot carry
// FFI bindings, so a package cannot bring SQLite along by itself. This
// command does it for the build: it compiles SQLite and the shim on first
// use (build.sh, which checks SQLite's hash), writes a manifest with
// absolute paths that also holds the functions and libraries of your own
// manifest if you pass one, and runs scriptc with it.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  process.stderr.write(`scriptc-sqlite: ${message}\n`);
  process.exit(1);
}

function newer(a, b) {
  return statSync(a).mtimeMs > statSync(b).mtimeMs;
}

/** Builds the archives for the lane if they are missing or out of date. */
function ensureArchives(sanitize) {
  const lib = join(packageDir, "build", sanitize ? "lib-san" : "lib");
  const sqlite = join(lib, "libsqlite3.a");
  const shim = join(lib, "libsqlite_shim.a");
  const sources = [join(packageDir, "native", "shim.c"), join(packageDir, "build.sh")];
  const stale = !existsSync(sqlite) || !existsSync(shim) || sources.some((s) => newer(s, shim));
  if (stale) {
    process.stderr.write(`scriptc-sqlite: building SQLite${sanitize ? " with AddressSanitizer" : ""} (once, about a minute)\n`);
    const result = spawnSync("sh", [join(packageDir, "build.sh")], {
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, SQLITE_SANITIZE: sanitize ? "1" : "0" },
    });
    if (result.status !== 0) fail("building SQLite failed (build.sh needs sh, curl or a downloaded zip, unzip and clang)");
  }
  return [shim, sqlite];
}

/** Our manifest, with absolute library paths, merged with the user's. */
function writeManifest(sanitize, userManifest) {
  const ours = JSON.parse(readFileSync(join(packageDir, "ffi.json"), "utf8"));
  const merged = {
    ffi_format: ours.ffi_format,
    functions: [...ours.functions],
    libraries: ensureArchives(sanitize),
    system_libraries: [...(ours.system_libraries ?? [])],
  };
  if (userManifest !== undefined) {
    const path = resolve(userManifest);
    const theirs = JSON.parse(readFileSync(path, "utf8"));
    const base = dirname(path);
    merged.ffi_format = Math.max(merged.ffi_format, theirs.ffi_format ?? 1);
    const names = new Set(merged.functions.map((f) => f.name));
    const symbols = new Set(merged.functions.map((f) => f.symbol));
    for (const f of theirs.functions ?? []) {
      if (names.has(f.name) || symbols.has(f.symbol))
        fail(`${userManifest}: function ${f.name} (${f.symbol}) clashes with one of scriptc-sqlite's`);
      merged.functions.push(f);
    }
    // The user's archives come first, so they may call SQLite themselves.
    const theirLibraries = (theirs.libraries ?? []).map((l) => (isAbsolute(l) ? l : resolve(base, l)));
    merged.libraries = [...theirLibraries, ...merged.libraries];
    for (const s of theirs.system_libraries ?? []) if (!merged.system_libraries.includes(s)) merged.system_libraries.push(s);
    for (const key of ["frameworks", "callbacks"]) if (theirs[key] !== undefined) merged[key] = theirs[key];
  }
  const text = JSON.stringify(merged, null, 2) + "\n";
  const dir = join(packageDir, "build", "manifests");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `ffi-${createHash("sha256").update(text).digest("hex").slice(0, 16)}.json`);
  if (!existsSync(file)) writeFileSync(file, text);
  return file;
}

/** scriptc from the project being built, else the one beside this package,
 * else whatever `scriptc` is on PATH. */
function findScriptc() {
  for (const from of [join(process.cwd(), "package.json"), join(packageDir, "package.json")]) {
    try {
      const pkgPath = createRequire(from).resolve("scriptc/package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.scriptc;
      if (!bin) continue;
      const path = join(dirname(pkgPath), bin);
      // The installed command is a native executable (bin/scriptc.exe on
      // every platform); older packages shipped a JavaScript launcher.
      return /\.[cm]?js$/.test(path) ? [process.execPath, path] : [path];
    } catch {
      // not installed there
    }
  }
  return ["scriptc"];
}

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
  process.stdout.write(
    "usage: scriptc-sqlite <scriptc command> [scriptc options]   e.g. scriptc-sqlite build app.ts -o app\n" +
      "       scriptc-sqlite manifest [--sanitize] [--ffi mine.json]\n",
  );
  process.exit(args.length === 0 ? 1 : 0);
}

// Take --ffi out of the arguments; it is merged into ours.
let userManifest;
const rest = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--ffi") {
    if (i + 1 >= args.length) fail("--ffi needs a file");
    userManifest = args[++i];
  } else if (a.startsWith("--ffi=")) userManifest = a.slice("--ffi=".length);
  else rest.push(a);
}
const sanitize = rest.includes("--sanitize");

if (rest[0] === "manifest") {
  process.stdout.write(writeManifest(sanitize, userManifest) + "\n");
  process.exit(0);
}

const manifest = writeManifest(sanitize, userManifest);
const [command, ...prefix] = findScriptc();
const result = spawnSync(command, [...prefix, ...rest, "--ffi", manifest], { stdio: "inherit" });
if (result.error) fail(`could not run scriptc: ${result.error.message}`);
process.exit(result.status ?? 1);
