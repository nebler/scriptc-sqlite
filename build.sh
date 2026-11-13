#!/bin/sh
# Builds SQLite into a static archive for the machine's own target, plus the
# shim, so a scriptc program links SQLite in and needs no system library.
#
#   . sqlite/env.sh && sh sqlite/build.sh
#
# Output: sqlite/build/lib/libsqlite3.a and libsqlite_shim.a, the archives
# sqlite/ffi.json links. Linux arm64 only so far; see NOTES.md for macOS and
# Windows.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
cd "$here"

# Pinned: version, URL and SHA3-256 from https://sqlite.org/download.html
# (the PRODUCT line in its page source), 13 November 2026.
version=3540100
year=2026
sha3=92281c86e2957f9b9305890f9ac04204caa7b677cc868dc326d942689df28e30
zip=build/dl/sqlite-amalgamation-$version.zip
src=build/dl/sqlite-amalgamation-$version

mkdir -p build/dl build/lib build/obj
if [ ! -f "$zip" ]; then
  curl -fsSL "https://sqlite.org/$year/sqlite-amalgamation-$version.zip" -o "$zip.part"
  mv "$zip.part" "$zip"
fi
got=$(node -e 'const c=require("crypto"),f=require("fs");process.stdout.write(c.createHash("sha3-256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$zip")
if [ "$got" != "$sha3" ]; then
  echo "build.sh: SHA3-256 of $zip is $got, expected $sha3; refusing to build" >&2
  exit 1
fi
echo "sqlite $version: SHA3-256 matches sqlite.org"
rm -rf "$src"
unzip -q -o "$zip" -d build/dl

CC=${SQLITE_CC:-clang}
# SQLITE_SANITIZE=1 builds the same archives with AddressSanitizer into
# build/lib-san (linked by ffi-sanitize.json), so the sanitized lane also
# checks SQLite and the shim, not only scriptc's own code.
lib=build/lib
obj=build/obj
extra=""
if [ "${SQLITE_SANITIZE:-0}" = 1 ]; then
  lib=build/lib-san
  obj=build/obj-san
  extra="-fsanitize=address -fno-omit-frame-pointer -g"
fi
mkdir -p "$lib" "$obj"
# Options as recommended by https://sqlite.org/compile.html, kept close to
# what Node's own node:sqlite build turns on so results match: threadsafe
# (scriptc programs can open connections on several threads), no shared
# cache, no deprecated APIs, no load_extension (nothing is loaded at run
# time), plus FTS5, JSON (built in since 3.38), math functions, RTREE and
# the column-metadata and session extras Node enables.
flags="-O2 -fPIC -DNDEBUG \
  -DSQLITE_THREADSAFE=1 \
  -DSQLITE_DEFAULT_MEMSTATUS=0 \
  -DSQLITE_DQS=0 \
  -DSQLITE_OMIT_DEPRECATED \
  -DSQLITE_OMIT_SHARED_CACHE \
  -DSQLITE_OMIT_LOAD_EXTENSION \
  -DSQLITE_LIKE_DOESNT_MATCH_BLOBS \
  -DSQLITE_ENABLE_FTS5 \
  -DSQLITE_ENABLE_MATH_FUNCTIONS \
  -DSQLITE_ENABLE_RTREE \
  -DSQLITE_ENABLE_COLUMN_METADATA \
  -DSQLITE_ENABLE_SESSION \
  -DSQLITE_ENABLE_PREUPDATE_HOOK"

echo "compiling sqlite3.c into $lib (about a minute)"
# shellcheck disable=SC2086
$CC $flags $extra -c "$src/sqlite3.c" -o "$obj/sqlite3.o"
rm -f "$lib/libsqlite3.a"
ar rcs "$lib/libsqlite3.a" "$obj/sqlite3.o"

# shellcheck disable=SC2086
$CC -O2 -fPIC -Wall -Wextra -Werror $extra -I"$src" -c native/shim.c -o "$obj/shim.o"
rm -f "$lib/libsqlite_shim.a"
ar rcs "$lib/libsqlite_shim.a" "$obj/shim.o"
ls -l "$lib"
