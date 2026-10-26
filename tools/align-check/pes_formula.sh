#!/bin/sh
# pes_formula.sh <stem>: the formula on the box (V1, V2, V10). Joins each buffer of
# record-bus.py --demux's <stem>.pads.jsonl with its PES in mrts_cli dump of the same bytes
# (<stem>.ts): its pad's PID (select mode's `src`: any PID), the next PES in stream order with
# its crc32 and length. Its PTS must be Phase 3's formula of the PES PTS (S12):
#   ceil((PTS - 1 h, unwrapped to the buffer's 2^33 period) x 100000 / 9) ns,
# its DTS the same of the PES DTS (a PES without one: no DTS, or the PTS). Prints a JSON line per
# pad (buffers, joined, exact: the ceil, floor: Phase 2's rounding, maxDevNs against the ceil)
# and a summary. Exit 0 when every buffer joined and is exact; 1 otherwise; 2 usage. Needs gawk.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
CLI=${MRTS_CLI:-$here/../../plugins/mpegts-core/native/mrts/mrts_cli}
[ $# -eq 1 ] || { sed -n '2,10p' "$0" >&2; exit 2; }
stem=$1
[ -e "$stem.ts" ] && [ -e "$stem.pads.jsonl" ] || { echo "pes_formula.sh: no $stem.ts or $stem.pads.jsonl" >&2; exit 2; }
T=$(mktemp -d "${TMPDIR:-/tmp}/pes_formula.XXXXXX")
trap 'rm -rf "$T"' EXIT
"$CLI" dump "$stem.ts" >"$T/dump.jsonl"

# gawk -M: integers past 2^53 (house ns after 104 days of uptime) stay exact.
gawk -M -v D="$T/dump.jsonl" '
function num(l, k,   x) { x = l; if (!sub(".*\"" k "\": *", "", x)) return ""; sub(" *[,}].*", "", x); gsub("\"", "", x); return x }
# The formula of a 33-bit PES time, in the 2^33 period nearest `near` (ns); both roundings.
function formula(raw, near,   t, d, k, x) {
    t = (raw - 324000000) % W; if (t < 0) t += W
    d = (near * 9 / 100000 - t) / W; k = d >= 0 ? int(d + 0.5) : -int(-d + 0.5)
    x = (t + k * W) * 100000
    FL = (x - x % 9) / 9; CE = FL + (x % 9 ? 1 : 0)
}
BEGIN {
    W = 8589934592
    while ((getline l < D) > 0) {
        if (l !~ /^\{"pid"/ || num(l, "pts") == "null") continue
        p = num(l, "pid") + 0; n = ++cnt[p]
        key[p, n] = num(l, "crc32") ":" num(l, "len"); pts[p, n] = num(l, "pts") + 0; dts[p, n] = num(l, "dts")
        order[++all] = p SUBSEP n
    }
    bad = 0
}
{
    pad = num($0, "pad"); bp = num($0, "pts"); bd = num($0, "dts"); c = num($0, "crc32") ":" num($0, "len")
    bufs[pad]++
    if (!(pad in pads)) { pads[pad] = ++npads; names[npads] = pad }
    if (bp == "null") { bad++; next }
    # demux pads are <media>_<generation>_<pid, 4 hex>; select mode'"'"'s pad carries any PID.
    want = pad ~ /_[0-9a-f]+_[0-9a-f][0-9a-f][0-9a-f][0-9a-f]$/ ? strtonum("0x" substr(pad, length(pad) - 3)) : -1
    hit = ""
    if (want >= 0) {
        for (q = (want in nx) ? nx[want] : 1; q <= cnt[want]; q++) if (key[want, q] == c) { hit = want SUBSEP q; nx[want] = q + 1; break }
    } else {
        for (q = (pad in gx) ? gx[pad] : 1; q <= all; q++) { split(order[q], o, SUBSEP); if (key[o[1], o[2]] == c) { hit = order[q]; gx[pad] = q + 1; break } }
    }
    if (hit == "") { bad++; next }
    joined[pad]++
    split(hit, h, SUBSEP)
    formula(pts[h[1], h[2]], bp)
    dev = bp - CE; ad = dev < 0 ? -dev : dev
    if (!(pad in mx) || ad > mxa[pad]) { mx[pad] = dev; mxa[pad] = ad }
    ok = bp == CE; if (bp == FL) fl[pad]++
    pd = dts[h[1], h[2]]
    if (pd == "null") { if (bd != "null" && bd != bp) ok = 0 }
    else { formula(pd, bd == "null" ? bp : bd); if (bd != CE) ok = 0 }
    if (ok) ex[pad]++; else bad++
}
END {
    for (i = 1; i <= npads; i++) {
        p = names[i]
        printf "{\"pad\":\"%s\",\"buffers\":%d,\"joined\":%d,\"exact\":%d,\"floor\":%d,\"maxDevNs\":%s}\n", p, bufs[p], joined[p] + 0, ex[p] + 0, fl[p] + 0, (p in mx) ? mx[p] : "null"
        total += bufs[p]
    }
    printf "{\"msg\":\"pes_formula\",\"pads\":%d,\"buffers\":%d,\"pass\":%s}\n", npads, total, bad || !total ? "false" : "true"
    exit bad || !total ? 1 : 0
}' "$stem.pads.jsonl"
