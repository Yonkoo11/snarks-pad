#!/bin/bash
# Test shim for test/api-treasury-load.test.ts: counts zcash-devtool invocations in $TMPDIR/devtool-calls, then runs the
# real binary (path in $TMPDIR/real-devtool; the engine passes devtool only PATH, HOME and TMPDIR).
echo "$*" >> "$TMPDIR/devtool-calls"
exec "$(cat "$TMPDIR/real-devtool")" "$@"
