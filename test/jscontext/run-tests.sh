#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$PROJECT_DIR"

# Compile Swift runner
echo "Compiling JSContext runner..."
swiftc test/jscontext/runner.swift -o test/jscontext/jsctx -framework JavaScriptCore -O

cleanup() {
  rm -f test/jscontext/jsctx
}
trap cleanup EXIT

FAILED=0
PASSED=0
TOTAL=0

for test in test/jscontext/test-*.js; do
  TOTAL=$((TOTAL + 1))
  name=$(basename "$test" .js)
  echo ""
  echo "=== Running $name ==="
  if ./test/jscontext/jsctx \
    test/jscontext/shim.js \
    build/worker.js \
    test/jscontext/helpers.js \
    "$test"; then
    PASSED=$((PASSED + 1))
    echo "=== $name: PASSED ==="
  else
    FAILED=$((FAILED + 1))
    echo "=== $name: FAILED ==="
  fi
done

echo ""
echo "Results: $PASSED/$TOTAL passed"
if [ $FAILED -ne 0 ]; then
  echo "$FAILED test(s) failed"
  exit 1
fi
echo "All tests passed!"
exit 0
