#!/usr/bin/env bash
# Builds the pinned zcash-devtool (the binary that holds the treasury key) from source, locked, and prints the
# sha256 to pin on the machine that runs it (audit/S2-SUPPLY-CHAIN.md). Same commit and features as
# probe/zcash-batch/README.md. Needs git, cargo and protoc.
#   bash scripts/build-devtool.sh [output-dir]      (default: probe/zcash-batch/work/bin)
# Then on the keeper: export ZCASH_DEVTOOL_BIN=<output-dir>/zcash-devtool ZCASH_DEVTOOL_SHA256=<the printed sha256>
# The pad refuses to run the binary if its checksum differs (src/zcash/devtool.ts). A rebuild on another machine
# or toolchain gives another checksum: pin the one of the binary you actually copied to the keeper.
set -euo pipefail

COMMIT="5a26ee8"   # tested 2026-08-28 (probe/zcash-batch/README.md)
REPO="https://github.com/zcash/zcash-devtool"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$HERE/../probe/zcash-batch/work/bin}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

command -v cargo >/dev/null || { echo "cargo is required" >&2; exit 1; }
command -v protoc >/dev/null || { echo "protoc is required (brew install protobuf)" >&2; exit 1; }

git clone --quiet "$REPO" "$WORK/zcash-devtool"
cd "$WORK/zcash-devtool"
git checkout --quiet "$COMMIT"
HEAD_SHA="$(git rev-parse HEAD)"
case "$HEAD_SHA" in "$COMMIT"*) ;; *) echo "checked out $HEAD_SHA, expected $COMMIT" >&2; exit 1;; esac
[ -f Cargo.lock ] || { echo "no Cargo.lock at $COMMIT: refusing an unlocked build" >&2; exit 1; }

cargo build --release --locked --features regtest_support
mkdir -p "$OUT"
cp target/release/zcash-devtool "$OUT/zcash-devtool"
SUM="$(shasum -a 256 "$OUT/zcash-devtool" | cut -d' ' -f1)"
echo "$SUM  zcash-devtool  (commit $HEAD_SHA)" > "$OUT/zcash-devtool.sha256"
echo "built $OUT/zcash-devtool from $HEAD_SHA"
echo "ZCASH_DEVTOOL_SHA256=$SUM"
