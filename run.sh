#!/bin/sh
# Day 1 check: test.mts under Node (node:sqlite) and as scriptc binaries
# (release and sanitized), outputs compared byte for byte, plus binary size
# and peak memory. No timings: this box's timings are not results.
#
#   . sqlite/env.sh && sh sqlite/run.sh
#
# Writes build/node.out, build/release.out, build/sanitized.out and
# build/summary.txt.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
cd "$here"
scriptc=./node_modules/.bin/scriptc

for d in lib lib-san; do
  if [ ! -f build/$d/libsqlite3.a ] || [ ! build/$d/libsqlite_shim.a -nt native/shim.c ] || [ ! build/$d/libsqlite_shim.a -nt build.sh ]; then
    if [ $d = lib ]; then sh build.sh; else SQLITE_SANITIZE=1 sh build.sh; fi
  fi
done
mkdir -p build/bin
clang -O2 -Wall -o build/bin/peakrss tools/peakrss.c

echo "scriptc $($scriptc --version), node $(node --version)" > build/summary.txt

node test.mts > build/node.out 2> build/node.err
build/bin/peakrss node test.mts > /dev/null 2> build/node.rss

echo "building release binary"
$scriptc build test.mts --ffi ffi.json -o build/bin/test > build/release.build 2>&1
echo "building sanitized binary"
$scriptc build test.mts --ffi ffi-sanitize.json --sanitize -o build/bin/test-san > build/sanitized.build 2>&1

status=0
for lane in release sanitized; do
  exe=build/bin/test
  [ "$lane" = sanitized ] && exe=build/bin/test-san
  code=0
  build/bin/peakrss "$exe" > build/$lane.out 2> build/$lane.err || code=$?
  if cmp -s build/node.out build/$lane.out; then same=identical; else same=DIFFERENT; status=1; fi
  # Anything on stderr besides the memory line is a finding (sanitizer
  # reports land there).
  extra=$(grep -v '^peak-rss-kib ' build/$lane.err | wc -l)
  [ "$code" -eq 0 ] && [ "$extra" -eq 0 ] || status=1
  echo "$lane: exit $code, output $same to Node, stderr lines besides memory $extra, $(grep '^peak-rss-kib' build/$lane.err)" >> build/summary.txt
done
echo "node: $(cat build/node.rss)" >> build/summary.txt

# A small, ordinary program, for a fairer memory figure.
$scriptc build small.mts --ffi ffi.json -o build/bin/small > build/small.build 2>&1
build/bin/peakrss node small.mts > build/small-node.out 2> build/small-node.err
code=0
build/bin/peakrss build/bin/small > build/small.out 2> build/small.err || code=$?
if cmp -s build/small-node.out build/small.out; then same=identical; else same=DIFFERENT; status=1; fi
[ "$code" -eq 0 ] || status=1
echo "small.mts: exit $code, output $same to Node; scriptc $(grep '^peak-rss' build/small.err), node $(grep '^peak-rss' build/small-node.err)" >> build/summary.txt

size() { wc -c < "$1" | tr -d ' '; }
cp build/bin/test build/bin/test-stripped
llvm-strip build/bin/test-stripped
{
  echo "release binary bytes $(size build/bin/test), stripped $(size build/bin/test-stripped)"
  echo "sanitized binary bytes $(size build/bin/test-san)"
  echo "libsqlite3.a bytes $(size build/lib/libsqlite3.a)"
  echo "dynamic libraries of the release binary:"
  llvm-readelf -d build/bin/test | grep NEEDED | sed 's/^/  /'
} >> build/summary.txt
cat build/summary.txt
[ "$status" -eq 0 ] && echo "PASS" || { echo "FAIL: see build/*.out and build/*.err"; diff build/node.out build/release.out | head -20 || true; }
exit $status
