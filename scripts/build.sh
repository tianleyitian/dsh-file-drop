#!/bin/bash
# dsh-dropin build: link type deps from the installed dsh npm package, then
# tsc (host) + tsdown (client bundle). Requires bash + node + npm on PATH.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "=== Linking build dependencies ==="
node scripts/link-deps.mjs

echo "=== Compiling src -> lib (tsc) ==="
if [ -f node_modules/.bin/tsc.cmd ]; then
  cmd //c "node_modules\\.bin\\tsc.cmd" -p tsconfig.json
else
  node_modules/.bin/tsc -p tsconfig.json
fi

echo "=== Building client bundle (tsdown) ==="
if [ -f node_modules/.bin/tsdown.cmd ]; then
  cmd //c "node_modules\\.bin\\tsdown.cmd"
else
  node_modules/.bin/tsdown
fi

echo "=== Build complete ==="
