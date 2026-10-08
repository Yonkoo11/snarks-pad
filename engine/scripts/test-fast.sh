#!/usr/bin/env bash
# The fast lane: every engine test file that needs neither the local Solana validator nor the Zcash tools (zebrad, zainod,
# zcash-devtool), run from a fresh database. Use it for every change; `bun run test` (the full suite, about 15 minutes with the
# nodes up) before a deploy and nightly. The split is by what a file imports or asks for, so a new file lands in the right lane
# on its own.
#   bun run test:fast            the fast lane
#   bun run test:fast -- <args>  extra bun test arguments (for example --test-name-pattern)
set -euo pipefail
cd "$(dirname "$0")/.."
NEEDS_CHAIN='validator|regtest|local-up|zcash-devtool|zebrad|zainod|LIVE_|live test|airdrop|mainnet binary'
files=()
for f in test/*.test.ts; do
  grep -q -E "$NEEDS_CHAIN" "$f" || files+=("./$f")
done
echo "fast lane: ${#files[@]} of $(ls test/*.test.ts | wc -l | tr -d ' ') test files (the rest need the local chain or the Zcash tools)"
rm -f data/test-fast.sqlite data/test-fast.sqlite-wal data/test-fast.sqlite-shm
# 20 s per test instead of 5: the ops tests spawn bash and stand-in tools and flaked at 5 s under load (2026-10-07)
PAD_DB_FILE=data/test-fast.sqlite exec bun test --timeout 20000 "${files[@]}" "$@"
