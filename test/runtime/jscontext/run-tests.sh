#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
JSCONTEXT_DIR="test/runtime/jscontext"
cd "$PROJECT_DIR"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "Skipping JSContext runtime tests: JavaScriptCore.framework is only available on Apple platforms."
  exit 0
fi

# Compile Swift runner
echo "Compiling JSContext runner..."
swiftc "$JSCONTEXT_DIR/runner.swift" -o "$JSCONTEXT_DIR/jsctx" -framework JavaScriptCore -O

cleanup() {
  rm -f "$JSCONTEXT_DIR/jsctx"
}
trap cleanup EXIT

FAILED=0
PASSED=0
TOTAL=0

for test in "$JSCONTEXT_DIR"/test-*.js; do
  TOTAL=$((TOTAL + 1))
  name=$(basename "$test" .js)
  echo ""
  echo "=== Running $name ==="
  if ./"$JSCONTEXT_DIR/jsctx" \
    "$JSCONTEXT_DIR/shim.js" \
    build/worker.js \
    "$JSCONTEXT_DIR/helpers.js" \
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
