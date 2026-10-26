#!/bin/sh
# gen-thirdparty.sh [OUT_DIR]: the third-party conformance fixtures (plan ch. 7 WI-P3-3, S24),
# made once on the dev Pi and committed with this script: libavformat's mpegts muxer (ffmpeg
# 5.1, the vMix's) on testsrc2 and sine, 8 s each, and one GStreamer-made ID3 stream. Each
# is moved onto house PES at 1000 s (mrts_cli rebase), dumped to its .expect.jsonl, <= 2 MB.
# OUT_DIR defaults to plugins/mpegts-core/tests/fixtures; MRTS_CLI overrides the CLI path.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=${1:-$HERE/../../plugins/mpegts-core/tests/fixtures}
CLI=${MRTS_CLI:-$HERE/../../plugins/mpegts-core/native/mrts/mrts_cli}
T=$(mktemp -d "${TMPDIR:-/tmp}/gen-thirdparty.XXXXXX")
trap 'rm -rf "$T"' EXIT
# A private registry: the user's is never rebuilt.
export GST_REGISTRY="$T/registry.bin"

D=8
V="-f lavfi -i testsrc2=size=640x360:rate=25:duration=$D"
A="-f lavfi -i sine=frequency=1000:sample_rate=48000:duration=$D"
X264="-c:v libx264 -preset veryfast -b:v 600k -g 25 -x264-params threads=1:sliced-threads=0"
AAC="-c:a aac -b:a 128k -ac 2"
ff() {   # name, then ffmpeg's input and codec arguments; one thread, bit-exact
    name=$1
    shift
    # shellcheck disable=SC2068
    ffmpeg -hide_banner -loglevel error -nostdin -y "$@" -fflags +bitexact -flags:v +bitexact \
        -flags:a +bitexact -threads 1 -f mpegts "$T/$name.ts"
}

# shellcheck disable=SC2086
{
    ff tp-mpeg2video-mp2 $V $A -map 0:v -map 1:a -c:v mpeg2video -b:v 1M -g 12 -bf 2 -c:a mp2 -b:a 192k -ac 2
    ff tp-h264-ac3-eac3 $V $A -map 0:v -map 1:a -map 1:a $X264 -c:a:0 ac3 -b:a:0 192k -c:a:1 eac3 -b:a:1 192k -ac 2
    ff tp-h264-ac3-eac3-system-b $V $A -map 0:v -map 1:a -map 1:a $X264 -c:a:0 ac3 -b:a:0 192k -c:a:1 eac3 \
        -b:a:1 192k -ac 2 -mpegts_flags system_b
    ff tp-h264-latm $V $A -map 0:v -map 1:a $X264 $AAC -mpegts_flags latm
    ff tp-hevc-aac $V $A -map 0:v -map 1:a -c:v libx265 -b:v 500k -g 25 \
        -x265-params pools=none:frame-threads=1:log-level=error $AAC
    ff tp-h264-dts $V $A -map 0:v -map 1:a $X264 -c:a dca -strict -2 -b:a 768k -ac 2
    ff tp-opus-51 $V -f lavfi \
        -i "aevalsrc=sin(440*2*PI*t)|sin(550*2*PI*t)|sin(660*2*PI*t)|0.1*sin(55*2*PI*t)|sin(770*2*PI*t)|sin(880*2*PI*t):s=48000:c=5.1:d=$D" \
        -map 0:v -map 1:a $X264 -c:a libopus -b:a 256k -mapping_family 1
}

# DVB subtitles: GStreamer's dvbsubenc renders three cues (textrender), ffmpeg muxes them by
# stream copy (its own dvbsub decoder refuses that encoder's odd-height bitmaps, so it cannot
# re-encode them).
printf '1\n00:00:00,500 --> 00:00:02,000\nFirst line\n\n2\n00:00:02,500 --> 00:00:04,500\nSecond line\n\n3\n00:00:05,000 --> 00:00:07,500\nThird line\n' >"$T/cues.srt"
gst-launch-1.0 -q filesrc location="$T/cues.srt" ! subparse ! textrender ! video/x-raw,width=720,height=576 ! \
    dvbsubenc ! mpegtsmux ! filesink location="$T/cues.ts" >/dev/null 2>&1
# shellcheck disable=SC2086
ff tp-h264-dvbsub $V $A -i "$T/cues.ts" -map 0:v -map 1:a -map 2:s $X264 $AAC -c:s copy

# ID3: timed meta/x-id3 (one ID3v2.4 TXXX tag a second) beside AAC into mpegtsmux.
python3 - "$T/tp-id3.ts" <<'EOF'
import sys

import gi

gi.require_version("Gst", "1.0")
from gi.repository import Gst  # noqa: E402

Gst.init([])
p = Gst.parse_launch(
    f"mpegtsmux name=m ! filesink location={sys.argv[1]} "
    "audiotestsrc num-buffers=375 samplesperbuffer=1024 ! audio/x-raw,rate=48000,channels=2 ! avenc_aac ! "
    "aacparse ! m. appsrc name=id3 caps=meta/x-id3,parsed=(boolean)true format=time ! m.")
src = p.get_by_name("id3")


def syncsafe(n):
    return bytes([(n >> 21) & 0x7F, (n >> 14) & 0x7F, (n >> 7) & 0x7F, n & 0x7F])


p.set_state(Gst.State.PLAYING)
for i in range(8):
    body = b"\x03\x00" + f"cue {i}".encode()
    frame = b"TXXX" + syncsafe(len(body)) + b"\x00\x00" + body
    b = Gst.Buffer.new_wrapped(b"ID3\x04\x00\x00" + syncsafe(len(frame)) + frame)
    b.pts, b.duration = i * Gst.SECOND, Gst.SECOND
    src.emit("push-buffer", b)
src.emit("end-of-stream")
msg = p.get_bus().timed_pop_filtered(30 * Gst.SECOND, Gst.MessageType.EOS | Gst.MessageType.ERROR)
p.set_state(Gst.State.NULL)
sys.exit(0 if msg and msg.type == Gst.MessageType.EOS else 1)
EOF

for f in "$T"/tp-*.ts; do
    name=$(basename "$f" .ts)
    "$CLI" rebase "$f" "$OUT/$name.ts" --to-ns 1000000000000 >/dev/null
    "$CLI" dump "$OUT/$name.ts" >"$OUT/$name.expect.jsonl"
    size=$(wc -c <"$OUT/$name.ts" | tr -d ' ')
    [ "$size" -le 2000000 ] || { echo "gen-thirdparty: $name.ts is $size bytes, over 2 MB" >&2; exit 1; }
    echo "$name.ts $size"
done
