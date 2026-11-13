#!/bin/sh
# The whole check: every program under Node (node:sqlite) and as scriptc
# binaries built through bin/scriptc-sqlite.mjs (the way another project
# builds), release and sanitized, outputs compared byte for byte, plus
# binary size and peak memory. No timings: this box's timings are not
# results.
#
#   . sqlite/env.sh && sh sqlite/run.sh
#
# Writes build/*.out and build/summary.txt.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
cd "$here"
cli="node bin/scriptc-sqlite.mjs"

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

for name in test threads small; do
  build/bin/peakrss node $name.mts > build/$name-node.out 2> build/$name-node.err
  echo "building $name"
  $cli build $name.mts -o build/bin/$name > build/$name.build 2>&1
  compare $name release
  note "$name node: $(grep '^peak-rss' build/$name-node.err)"
done
for name in test threads; do
  echo "building $name, sanitized"
  $cli build $name.mts --sanitize -o build/bin/$name-san > build/$name-san.build 2>&1
  compare $name sanitized
done

# The statement pool (scriptc only): bounded statements, nothing leaks.
echo "building pool"
$cli build pool.mts -o build/bin/pool > build/pool.build 2>&1
$cli build pool.mts --sanitize -o build/bin/pool-san > build/pool-san.build 2>&1
for exe in pool pool-san; do
  code=0
  build/bin/peakrss build/bin/$exe > build/$exe.out 2> build/$exe.err || code=$?
  extra=$(grep -cv '^peak-rss-kib ' build/$exe.err || true)
  most=$(sed -n 's/.*at most \([0-9]*\).*/\1/p' build/$exe.out)
  [ "$code" -eq 0 ] && [ "$extra" -eq 0 ] && [ -n "$most" ] && [ "$most" -le 64 ] || status=1
  note "$exe: exit $code, $(head -1 build/$exe.out), other stderr lines $extra, $(grep '^peak-rss' build/$exe.err)"
done

# The example project, built as another project would build it.
echo "building the example project"
(cd example && npm run --silent build > ../build/example.build 2>&1) || status=1
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

size() { wc -c < "$1" | tr -d ' '; }
cp build/bin/test build/bin/test-stripped
llvm-strip build/bin/test-stripped
note "test binary bytes $(size build/bin/test), stripped $(size build/bin/test-stripped); example app bytes $(size example/build/app)"
note "dynamic libraries of the test binary: $(llvm-readelf -d build/bin/test | sed -n 's/.*Shared library: \[\(.*\)\]/\1/p' | tr '\n' ' ')"
cat build/summary.txt
if [ "$status" -eq 0 ]; then echo PASS; else echo "FAIL: see build/*.out and build/*.err"; fi
exit $status
