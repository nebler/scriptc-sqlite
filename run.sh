#!/bin/sh
# The whole check: every program under Node (node:sqlite) and as scriptc
# binaries built through bin/scriptc-sqlite.mjs (the way another project
# builds), release and sanitized, outputs compared byte for byte, plus
# binary size and peak memory. No timings: these runs are checks,
# not benchmarks.
#
#   npm ci && sh run.sh
#
# SANITIZE=0 sh run.sh skips the sanitized lane (for a machine without
# AddressSanitizer's runtime); the summary then says so and the result is
# "PASS, sanitized lane skipped", never a plain PASS.
#
# Writes build/*.out and build/summary.txt.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
cd "$here"
cli="node bin/scriptc-sqlite.mjs"
sanitize=${SANITIZE:-1}

mkdir -p build/bin
clang -O2 -Wall -o build/bin/peakrss tools/peakrss.c
echo "scriptc $(./node_modules/.bin/scriptc --version), node $(node --version)" > build/summary.txt
status=0

note() { echo "$*" >> build/summary.txt; }

# compare NAME LANE: runs build/bin/NAME[-san], compares with build/NAME-node.out
compare() {
  name=$1
  lane=$2
  exe=build/bin/$name
  [ "$lane" = sanitized ] && exe=build/bin/$name-san
  code=0
  build/bin/peakrss "$exe" > build/$name-$lane.out 2> build/$name-$lane.err || code=$?
  if cmp -s build/$name-node.out build/$name-$lane.out; then same=identical; else same=DIFFERENT; status=1; fi
  # Anything on stderr besides the memory line is a finding (sanitizer
  # reports land there).
  extra=$(grep -cv '^peak-rss-kib ' build/$name-$lane.err || true)
  [ "$code" -eq 0 ] && [ "$extra" -eq 0 ] || status=1
  note "$name $lane: exit $code, output $same to Node, other stderr lines $extra, $(grep '^peak-rss-kib' build/$name-$lane.err)"
}

for name in test threads udf-threads query migrate small; do
  build/bin/peakrss node $name.mts > build/$name-node.out 2> build/$name-node.err
  echo "building $name"
  $cli build $name.mts -o build/bin/$name > build/$name.build 2>&1
  compare $name release
  note "$name node: $(grep '^peak-rss' build/$name-node.err)"
done
# The older read path, one or two FFI calls per value, kept for the
# benchmark's comparison: the same answers.
SCRIPTC_SQLITE_ROW_READS=columns build/bin/test > build/test-columns.out 2>&1 || status=1
if cmp -s build/test-node.out build/test-columns.out; then note "test release, per-column reads: identical to Node"; else note "test release, per-column reads: DIFFERENT"; status=1; fi
if [ "$sanitize" = 1 ]; then
  for name in test threads udf-threads query migrate; do
    echo "building $name, sanitized"
    $cli build $name.mts --sanitize -o build/bin/$name-san > build/$name-san.build 2>&1
    compare $name sanitized
  done
else
  note "sanitized lane: SKIPPED (SANITIZE=0)"
fi

# The statement pool (scriptc only): bounded statements, nothing leaks.
echo "building pool"
$cli build pool.mts -o build/bin/pool > build/pool.build 2>&1
pools=pool
if [ "$sanitize" = 1 ]; then
  $cli build pool.mts --sanitize -o build/bin/pool-san > build/pool-san.build 2>&1
  pools="pool pool-san"
fi
for exe in $pools; do
  code=0
  build/bin/peakrss build/bin/$exe > build/$exe.out 2> build/$exe.err || code=$?
  extra=$(grep -cv '^peak-rss-kib ' build/$exe.err || true)
  most=$(sed -n 's/.*at most \([0-9]*\).*/\1/p' build/$exe.out)
  [ "$code" -eq 0 ] && [ "$extra" -eq 0 ] && [ -n "$most" ] && [ "$most" -le 64 ] || status=1
  # User functions and aggregate groups must all be gone at the end.
  grep -q 'functions ok$' build/$exe.out || status=1
  note "$exe: exit $code, $(head -1 build/$exe.out), other stderr lines $extra, $(grep '^peak-rss' build/$exe.err)"
  note "$exe: $(grep '^functions:' build/$exe.out)"
done

# The example project, built as another project would build it.
echo "building the example project"
(cd example && npm ci --no-audit --no-fund > ../build/example.install 2>&1 && npm run --silent build > ../build/example.build 2>&1) || status=1
rm -f build/tmp/notes.db
mkdir -p build/tmp
NOTES_DB=build/tmp/notes.db example/build/app add "first note ✓" > build/example.out
NOTES_DB=build/tmp/notes.db example/build/app add "second note 🙂" >> build/example.out
NOTES_DB=build/tmp/notes.db example/build/app find second >> build/example.out
printf 'added note 1 (tag %s)\nadded note 2 (tag %s)\n2  %s  second note 🙂\n' \
  "$(sed -n '1s/.*tag \(.*\))/\1/p' build/example.out)" "$(sed -n '2s/.*tag \(.*\))/\1/p' build/example.out)" \
  "$(sed -n '2s/.*tag \(.*\))/\1/p' build/example.out)" > build/example.expected
if cmp -s build/example.expected build/example.out; then note "example project: builds and runs"; else note "example project: WRONG OUTPUT"; status=1; fi
rm -f build/tmp/notes.db
(cd example && node ../bin/scriptc-sqlite.mjs build readme.ts -o build/readme > ../build/readme.build 2>&1) || status=1
if [ "$(example/build/readme)" = "1 hello 🙂" ]; then note "README example: builds and prints what the README says"; else note "README example: WRONG"; status=1; fi
# The README's SQL-function forms, including the two typed rest shapes.
(cd example && node ../bin/scriptc-sqlite.mjs build readme-functions.ts -o build/readme-functions > ../build/readme-functions.build 2>&1) || status=1
if [ "$(example/build/readme-functions | tr '\n' ' ')" = "hello-world second-note 6 3 4 " ]; then note "README function forms: build and run"; else note "README function forms: WRONG"; status=1; fi
# The README's query-builder example, importing scriptc-sqlite/query.
(cd example && node ../bin/scriptc-sqlite.mjs build readme-query.ts -o build/readme-query > ../build/readme-query.build 2>&1) || status=1
if [ "$(example/build/readme-query | tr '\n' ' ')" = "Ada has a cat Ada has a owl " ]; then note "README query example: builds and runs"; else note "README query example: WRONG"; status=1; fi

# The demo (marks), built as its own project, against its expected session.
echo "building the demo"
(cd demo && npm ci --no-audit --no-fund > ../build/demo.install 2>&1 && npm run --silent build > ../build/demo.build 2>&1) || status=1
sh demo/session.sh demo/build/marks build/tmp/marks-session > build/demo-session.out 2>&1
if cmp -s demo/session.expected build/demo-session.out; then note "demo: builds, session as expected"; else note "demo: SESSION DIFFERS (see build/demo-session.out)"; status=1; fi

# The starter project, set up from this checkout as a new user would from
# GitHub, built and run.
echo "building the starter project"
rm -rf build/tmp/starter
cp -r template build/tmp/starter
(cd build/tmp/starter && SCRIPTC_SQLITE_SOURCE="$here" node setup.mjs > ../../starter.install 2>&1 && npm run --silent build > ../../starter.build 2>&1) || status=1
starter() { TODO_DB=build/tmp/starter/todo.db build/tmp/starter/build/app "$@"; }
got=$( (starter add first; starter add second; starter done 1; starter list) | tr '\n' '|')
if [ "$got" = "added 1|added 2|done 1|[x] 1  first|[ ] 2  second|" ]; then note "starter project: sets up, builds and runs"; else note "starter project: WRONG ($got)"; status=1; fi

# The benchmark programs agree with each other (no timings: --check).
echo "checking the benchmark programs"
if node bench/run.mjs --check --only=scriptc,scriptc-columns,node > build/bench-check.out 2>&1; then note "benchmark programs: checksums agree (scriptc, per-column reads, node)"; else note "benchmark programs: CHECKSUMS DIFFER (see build/bench-check.out)"; status=1; fi

size() { wc -c < "$1" | tr -d ' '; }
cp build/bin/test build/bin/test-stripped
strip build/bin/test-stripped
note "test binary bytes $(size build/bin/test), stripped $(size build/bin/test-stripped); example app bytes $(size example/build/app)"
if [ "$(uname)" = Darwin ]; then
  libs=$(otool -L build/bin/test | tail -n +2 | awk '{print $1}' | tr '\n' ' ')
else
  libs=$(readelf -d build/bin/test | sed -n 's/.*Shared library: \[\(.*\)\]/\1/p' | tr '\n' ' ')
fi
note "dynamic libraries of the test binary: $libs"
# SQLite must be compiled in, never taken from the system.
case "$libs" in *sqlite*) note "FAIL: links a system SQLite"; status=1 ;; esac
cat build/summary.txt
if [ "$status" -eq 0 ] && [ "$sanitize" != 1 ]; then echo "PASS, sanitized lane skipped"
elif [ "$status" -eq 0 ]; then echo PASS; else echo "FAIL: see build/*.out and build/*.err"; fi
exit $status
