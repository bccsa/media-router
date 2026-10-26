#!/bin/sh
# pes_diff.sh <a.ts> <b.ts> [--by crc32|pts] [--map A:B[,A:B...]] [--tol TICKS] [--lines]
# Joins the PES of two captures of one stream, a before a hop and b after it (mrts_cli dump of
# each), per PID, and reports b - a of PTS and DTS in 90 kHz ticks, wrap-folded (V1, V2).
#   --by crc32  (default) pairs a PES with the same payload (crc32 and length; equal payloads in
#               PTS order): a hop that passes access units through.
#   --by pts    pairs each PES of b with a's of the nearest PTS within half its PID's median
#               spacing: a re-encode, whose payloads differ (plan part 9).
#   --map A:B   pairs a's PID A with b's PID B (decimal or 0x); default each PID with itself.
#   --tol N     the largest |delta| that passes (0).   --lines  a line per joined pair too.
# One JSON line per PID pair, then a summary. Exit 0: every joined delta within --tol and no PES
# without a partner inside both captures' span; 1 otherwise; 2 usage. MRTS_CLI: the CLI's path.
# Needs gawk (asort, strtonum).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
CLI=${MRTS_CLI:-$here/../../plugins/mpegts-core/native/mrts/mrts_cli}
usage() {
    sed -n '2,12p' "$0" >&2
    exit 2
}
[ $# -ge 2 ] || usage
a=$1 b=$2
shift 2
by=crc32 map="" tol=0 lines=0
while [ $# -gt 0 ]; do
    case $1 in
        --by) [ $# -ge 2 ] || usage; by=$2; shift ;;
        --map) [ $# -ge 2 ] || usage; map=$2; shift ;;
        --tol) [ $# -ge 2 ] || usage; tol=$2; shift ;;
        --lines) lines=1 ;;
        *) usage ;;
    esac
    shift
done
case $by in crc32 | pts) ;; *) usage ;; esac
T=$(mktemp -d "${TMPDIR:-/tmp}/pes_diff.XXXXXX")
trap 'rm -rf "$T"' EXIT
"$CLI" dump "$a" >"$T/a.jsonl"
"$CLI" dump "$b" >"$T/b.jsonl"

gawk -v by="$by" -v map="$map" -v tol="$tol" -v lines="$lines" -v A="$T/a.jsonl" -v B="$T/b.jsonl" '
function num(l, k,   x) { x = l; if (!sub(".*\"" k "\": *", "", x)) return ""; sub(" *[,}].*", "", x); gsub("\"", "", x); return x }
function fold(d) { d = d % W; if (d < 0) d += W; return d > W / 2 ? d - W : d }
function pidnum(s) { return s ~ /^0[xX]/ ? strtonum(s) : s + 0 }
function load(f, side,   l, p, n) {
    while ((getline l < f) > 0) {
        if (l !~ /^\{"pid"/ || num(l, "pts") == "null") continue
        p = num(l, "pid") + 0
        n = ++cnt[side, p]
        pts[side, p, n] = num(l, "pts") + 0
        unw[side, p, n] = num(l, "ptsUnwrapped") + 0
        dts[side, p, n] = num(l, "dts")
        c = key[side, p, n] = num(l, "crc32") ":" num(l, "len")
        if (side == "a") klist[p, c, ++kcnt[p, c]] = n   # a'\''s PES of each payload, in order
        seen[side, p] = 1
    }
    close(f)
}
BEGIN {
    W = 8589934592
    load(A, "a"); load(B, "b")
    if (map != "") {
        m = split(map, pairs, ",")
        for (i = 1; i <= m; i++) { split(pairs[i], ab, ":"); pa[i] = pidnum(ab[1]); pb[i] = pidnum(ab[2]) }
    } else {
        for (k in seen) { split(k, s, SUBSEP); if (s[1] == "a" && ("b", s[2]) in seen) { m++; pa[m] = s[2] + 0; pb[m] = s[2] + 0 } }
    }
    bad = 0; total = 0
    for (i = 1; i <= m; i++) {
        x = pa[i]; y = pb[i]; na = cnt["a", x] + 0; nb = cnt["b", y] + 0
        delete used; joined = 0; dmin = ""; dmax = ""; dnz = 0; tmin = ""; tmax = ""; tnz = 0; tmiss = 0
        # b on a'\''s unwrap: one 2^33 period for the whole capture, from the first PES of each.
        off = na && nb ? W * int((unw["a", x, 1] - unw["b", y, 1]) / W + (unw["a", x, 1] >= unw["b", y, 1] ? 0.5 : -0.5)) : 0
        lo = unw["a", x, 1]; hi = unw["a", x, na]
        if (by == "pts") {               # half the median spacing of a
            for (k = 2; k <= na; k++) sp[k - 1] = unw["a", x, k] - unw["a", x, k - 1]
            ns = na - 1; asort(sp); half = ns ? sp[int((ns + 1) / 2)] / 2 : 0; delete sp
        }
        j = 1
        for (k = 1; k <= nb; k++) {
            ub = unw["b", y, k] + off
            hit = 0
            if (by == "crc32") {
                # Of a'\''s unused PES with this payload, in order, the nearest in PTS.
                c = key["b", y, k]; L = kcnt[x, c] + 0
                q = (c in at) ? at[c] : 1
                while (q < L && (unw["a", x, klist[x, c, q + 1]] - ub) ^ 2 <= (unw["a", x, klist[x, c, q]] - ub) ^ 2) q++
                if (q <= L) { hit = klist[x, c, q]; at[c] = q + 1 }
            } else {
                while (j < na && (unw["a", x, j + 1] - ub) ^ 2 <= (unw["a", x, j] - ub) ^ 2) j++
                if (na && !(j in used) && (unw["a", x, j] - ub) ^ 2 <= half ^ 2) hit = j
            }
            if (!hit) { if (ub >= lo && ub <= hi) onlyb++; continue }
            used[hit] = 1; joined++
            dp = fold(pts["b", y, k] - pts["a", x, hit])
            if (dmin == "" || dp < dmin) dmin = dp; if (dmax == "" || dp > dmax) dmax = dp; if (dp) dnz++
            if (dp > tol || -dp > tol) bad++
            da = dts["a", x, hit]; db = dts["b", y, k]
            if ((da == "null") != (db == "null")) { tmiss++; bad++ }
            else if (da != "null") {
                dd = fold(db - da)
                if (tmin == "" || dd < tmin) tmin = dd; if (tmax == "" || dd > tmax) tmax = dd; if (dd) tnz++
                if (dd > tol || -dd > tol) bad++
            }
            if (lines) printf "{\"pidA\":%d,\"pidB\":%d,\"ptsA\":%d,\"ptsB\":%d,\"dPts\":%d,\"dDts\":%s}\n", x, y, pts["a", x, hit], pts["b", y, k], dp, da == "null" ? "null" : dd
        }
        # a PES inside b'\''s span that found no partner: gone on the way.
        blo = unw["b", y, 1] + off; bhi = unw["b", y, nb] + off; onlya = 0
        for (p = 1; p <= na; p++) if (!(p in used) && unw["a", x, p] >= blo && unw["a", x, p] <= bhi) onlya++
        bad += onlya + onlyb
        printf "{\"pidA\":%d,\"pidB\":%d,\"by\":\"%s\",\"a\":%d,\"b\":%d,\"joined\":%d,\"onlyA\":%d,\"onlyB\":%d,\"pts\":{\"min\":%s,\"max\":%s,\"nonzero\":%d},\"dts\":{\"min\":%s,\"max\":%s,\"nonzero\":%d,\"missing\":%d}}\n", x, y, by, na, nb, joined, onlya, onlyb, dmin == "" ? "null" : dmin, dmax == "" ? "null" : dmax, dnz, tmin == "" ? "null" : tmin, tmax == "" ? "null" : tmax, tnz, tmiss
        total += joined; onlyb = 0; delete at
    }
    printf "{\"msg\":\"pes_diff\",\"pairs\":%d,\"joined\":%d,\"tolTicks\":%d,\"pass\":%s}\n", m, total, tol, bad || !total ? "false" : "true"
    exit bad || !total ? 1 : 0
}'
