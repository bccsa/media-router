#!/bin/sh
# trim.sh <in.ts> <out.ts> [--bus] [--from S]: a fixture cut of a recording, S0's rule (plan
# ch. 3 part 7.2, OQ-2): from the last PAT before the first random access point at or after S
# seconds into its first stream that has one (a keyframe ffprobe flags on the first video
# stream, or any packet of a stream without video), at most 10,638 packets (1,999,944 bytes).
# --bus cuts the recording's sidecar (<in>.bus.jsonl) with it, on whole buffers, into
# <out>.bus.jsonl: the cut then starts at the buffer that holds that PAT and ends on the last
# whole buffer that fits.
set -eu
usage() {
    echo "usage: trim.sh in.ts out.ts [--bus] [--from S]" >&2
    exit 2
}
fail() {
    echo "trim.sh: $*" >&2
    exit 1
}
[ $# -ge 2 ] || usage
in=$1 out=$2
shift 2
bus=0 from=0
while [ $# -gt 0 ]; do
    case $1 in
        --bus) bus=1 ;;
        --from) [ $# -ge 2 ] || usage; from=$2; shift ;;
        *) usage ;;
    esac
    shift
done
sidecar() { echo "${1%.ts}.bus.jsonl"; }
max=1999944
rap=$(mktemp "${TMPDIR:-/tmp}/trim.XXXXXX")
trap 'rm -f "$rap"' EXIT
size=$(wc -c <"$in" | tr -d ' ')

# Random access points: each one's PES's first packet, as ffprobe gives it (pos).
sel=v:0
[ -n "$(ffprobe -v quiet -select_streams v:0 -show_entries stream=index -of csv=p=0 "$in")" ] || sel=0
ffprobe -v quiet -select_streams "$sel" -show_entries packet=pts_time,pos,flags -of csv=p=0 "$in" |
    awk -F, -v from="$from" 'NF >= 3 && $1 != "N/A" { if (t0 == "") t0 = $1; if ($1 >= t0 + from && $3 ~ /K/) print $2 }' |
    head -n 1000 >"$rap"
# The first of them with a PAT (PID 0 with PUSI) since the one before, on its 188-byte grid:
# the cut starts at that PAT.
pos="" at=-1 prev=-188
while read -r r; do
    a=$r
    while [ "$a" -gt "$prev" ] && [ "$a" -ge 0 ]; do
        # shellcheck disable=SC2046
        set -- $(od -An -tu1 -j "$a" -N 3 "$in")
        if [ "$1" = 71 ] && [ $(($2 & 64)) -ne 0 ] && [ $((($2 & 31) * 256 + $3)) -eq 0 ]; then
            at=$a pos=$r
            break 2
        fi
        a=$((a - 188))
    done
    prev=$r
done <"$rap"
[ -n "$pos" ] || fail "$in: no PAT before a random access point $from s in"

if [ "$bus" -eq 1 ]; then
    [ -e "$(sidecar "$in")" ] || fail "no $(sidecar "$in")"
    # The buffer holding the PAT, and the whole buffers after it that fit.
    span=$(awk -v at="$at" -v max="$max" '
        { o = $0; sub(/.*"off":/, "", o); sub(/,.*/, "", o); l = $0; sub(/.*"len":/, "", l); sub(/,.*/, "", l)
          o += 0; l += 0
          if (start == "" && o <= at && at < o + l) start = o
          if (start != "" && o + l - start <= max) end = o + l }
        END { if (start != "") print start, end }' "$(sidecar "$in")")
    [ -n "$span" ] || fail "$(sidecar "$in"): no buffer holds byte $at"
    start=${span% *} end=${span#* }
    awk -v s="$start" -v e="$end" '
        { o = $0; sub(/.*"off":/, "", o); sub(/,.*/, "", o); o += 0
          if (o >= s && o < e) { sub(/"off":[0-9]*/, "\"off\":" (o - s)); print } }' "$(sidecar "$in")" >"$(sidecar "$out")"
else
    start=$at
    end=$((size - (size - start) % 188))
    [ $((end - start)) -le "$max" ] || end=$((start + max))
fi
tail -c +$((start + 1)) "$in" | head -c $((end - start)) >"$out"
echo "trim.sh: $out: bytes $start to $end of $in ($(((end - start) / 188)) packets), PAT at $at, random access point at $pos"
