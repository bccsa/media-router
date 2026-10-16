#!/bin/sh
# capture_mux.sh EDGE [OUT.ts] [BYTES] - record one bus edge as an extra, read-only consumer
# (the fan-out sheds a slow extra consumer, never the real one). Run on the box. EDGE is the
# edge socket's 6-hex suffix or the connection id it is hashed from (see README.md).
EDGE=${1:?usage: capture_mux.sh EDGE [OUT.ts] [BYTES]}
OUT=${2:-/tmp/avskew/mux.ts}
BYTES=${3:-28000000}          # ~25 s at 8.8 Mbit/s
ROOT=${MR_ROOT:-/opt/media-router}
CLIENT=$ROOT/plugins/unixfdbus-core/py/unixfd-fanout.test-client.py
SOCKDIR=${MR_BUS_SOCKET_DIR:-/tmp}

case $EDGE in
    *:*)  # busHelpers.ts shortHash: 32-bit FNV-1a of the connection id, last 6 hex digits
        SUFFIX=$(python3 -c 'import sys
h = 0x811c9dc5
for c in sys.argv[1]:
    h = ((h ^ ord(c)) * 0x01000193) & 0xffffffff
print(("%x" % h).rjust(6, "0")[-6:])' "$EDGE") || exit 1 ;;
    *) SUFFIX=$EDGE ;;
esac
# The port changes on every engine restart, the suffix does not: take the newest socket.
SOCK=$(ls -t "$SOCKDIR"/mr-bus-*-"$SUFFIX".sock 2>/dev/null | head -n 1)
if [ -z "$SOCK" ]; then
    echo "no $SOCKDIR/mr-bus-*-$SUFFIX.sock - engine down, edge not attached, or wrong EDGE" >&2
    exit 1
fi
if [ ! -f "$CLIENT" ]; then
    echo "no $CLIENT - set MR_ROOT to the engine's install or checkout" >&2
    exit 1
fi
mkdir -p "$(dirname "$OUT")"
echo "edge $SOCK (created $(stat -c %y "$SOCK" | cut -c1-19)), capture start $(date -u +%Y-%m-%dT%H:%M:%SZ)"
python3 "$CLIENT" "$SOCK" --capture "$OUT" --expect-bytes "$BYTES" || exit 1
echo "capture end $(date -u +%Y-%m-%dT%H:%M:%SZ)"
