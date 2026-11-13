#!/bin/sh
# Runs every marks command against a fresh database, for run.sh to compare
# with session.expected:  sh demo/session.sh <marks executable> <work dir>
set -u
marks=$1
work=$2
rm -rf "$work"
mkdir -p "$work"
export MARKS_DB="$work/marks.db"
run() {
  echo "\$ marks $*"
  "$marks" "$@" 2>&1
  echo "(exit $?)"
}
run add https://sqlite.org/fts5.html "SQLite FTS5 Extension" --tag sqlite --tag search
run add https://www.sqlite.org/lang_upsert.html "UPSERT in SQLite" --tag sqlite
run add https://scriptc.dev/docs/ffi "scriptc: calling C libraries" --tag scriptc --tag Docs
run add https://nodejs.org/api/sqlite.html "node:sqlite — Node.js docs" --tag docs
run add https://example.com "Ünïcödé 🙂 test page"
run add https://scriptc.dev/docs/ffi "scriptc FFI: calling C from TypeScript" --tag ffi
run list
run list --tag docs
run find sqlite
run find "calling c"
run find 🙂
run find nothing-like-this
run tags
run stats
run export
"$marks" export > "$work/export.json"
run rm 2
run rm 99
run find upsert
run backup "$work/copy.db"
MARKS_DB="$work/fresh.db" "$marks" import "$work/export.json"
MARKS_DB="$work/fresh.db" "$marks" list --tag sqlite
MARKS_DB="$work/fresh.db" "$marks" stats
run add only-a-url
run nonsense
