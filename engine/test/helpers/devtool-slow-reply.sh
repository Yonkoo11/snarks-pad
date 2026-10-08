#!/bin/bash
# Test shim for test/zcash-intent-live.test.ts (audit O-4): runs the real zcash-devtool. For `pay`, the transaction is
# built and broadcast by the real binary, then the reply (the txid) is held back: the window in which a keeper that
# dies has sent money it has no record of. The engine passes devtool only PATH, HOME and TMPDIR (audit S2-14), so the
# real binary's path and the delay are read from files in TMPDIR that the test writes.
REAL="$(cat "$TMPDIR/o4-real-devtool")"
case " $* " in
  *" pay "*)
    out=$("$REAL" "$@"); code=$?
    [ -f "$TMPDIR/o4-delay" ] && sleep "$(cat "$TMPDIR/o4-delay")"
    printf '%s\n' "$out"
    exit $code ;;
esac
exec "$REAL" "$@"
