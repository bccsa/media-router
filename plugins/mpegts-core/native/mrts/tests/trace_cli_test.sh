#!/bin/sh
# trace_cli_test: the arrival-trace tools at the command line (WI-P1-2): generator and replay
# determinism, the .stct <-> JSONL round trip, every expectation in tests/fixtures/restamp (a
# synthetic trace regenerated from its "source" line), bad input refused; the replay rebase,
# Phase 3's --ts kinds and --respace (WI-P3-3); pcrcheck, hcdesc and dump --net (WI-P5-5);
# trace version 2's declarations (p5-6t); check.h's output.
#   MRTS_CLI, FIXTURE_GEN, RESTAMP_FIXTURES, TS_FIXTURES override the default paths.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
CLI=${MRTS_CLI:-$HERE/../mrts_cli}
GEN=${FIXTURE_GEN:-$HERE/fixture_gen}
FIX=${RESTAMP_FIXTURES:-$HERE/../../../tests/fixtures/restamp}
TSFIX=${TS_FIXTURES:-$HERE/../../../tests/fixtures}
T=$(mktemp -d "${TMPDIR:-/tmp}/trace_cli_test.XXXXXX") || exit 1
trap 'rm -rf "$T"' EXIT
fails=0

check() {   # name, then the command's status: 0 passes
    if [ "$2" -eq 0 ]; then echo "PASS $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi
}
status() { "$@" >/dev/null 2>&1; echo $?; }

# The generator: one seed, one file; another seed, another; nonsense refused.
"$GEN" --trace -o "$T/a.stct" --seed 5 --duration 30 --outage 10:1500 --jump 20:-1000:di
"$GEN" --trace -o "$T/b.stct" --seed 5 --duration 30 --outage 10:1500 --jump 20:-1000:di
"$GEN" --trace -o "$T/c.stct" --seed 6 --duration 30 --outage 10:1500 --jump 20:-1000:di
cmp -s "$T/a.stct" "$T/b.stct"; check "fixture_gen: the same arguments and seed write the same bytes" $?
! cmp -s "$T/a.stct" "$T/c.stct"; check "fixture_gen: another seed writes other bytes" $?
[ "$(status "$GEN" --trace -o "$T/x.stct" --ppm 5,7)" = 2 ] && [ "$(status "$GEN" --trace -o "$T/x.stct" --pids v,zz)" = 2 ] &&
    [ "$(status "$GEN" -o "$T/x.stct")" = 2 ] && [ "$(status "$GEN" --trace)" = 2 ] &&
    [ "$(status "$GEN" --trace -o "$T/x.stct" --jump 5:10:xx)" = 2 ] &&
    [ "$(status "$GEN" --trace -o "$T/x.stct" --backlog 0:0:1000)" = 2 ] &&
    [ "$(status "$GEN" --trace -o "$T/x.stct" --backlog 0:1000)" = 2 ] &&
    [ "$(status "$GEN" --trace -o "$T/x.stct" --ahead zz:100)" = 2 ] &&
    [ "$(status "$GEN" --trace -o "$T/x.stct" --scatter-ms 250:50)" = 2 ] &&
    [ "$(status "$GEN" --trace -o "$T/x.stct" --scatter-floor 101)" = 2 ] &&
    [ "$(status "$GEN" --trace -o "$T/x.stct" --scatter-floor 40)" = 2 ] &&
    [ "$(status "$GEN" --trace -o "$T/x.stct" --scatter-ms 0 --scatter-floor 40)" = 2 ] &&
    [ "$(status "$GEN" --shift 257:x -i "$T/a.stct" -o "$T/x.stct")" = 2 ] &&
    [ "$(status "$GEN" --shift 9000:100 -i "$T/a.stct" -o "$T/x.stct")" = 2 ] &&
    [ "$(status "$GEN" --shift 257:100 -o "$T/x.stct")" = 2 ] &&
    [ "$(status "$GEN" --freeze-pcr 10 -i "$T/a.stct" -o "$T/x.stct")" = 2 ] &&
    [ "$(status "$GEN" --freeze-pcr 10:-1 -i "$T/a.stct" -o "$T/x.stct")" = 2 ] &&
    [ "$(status "$GEN" --freeze-pcr 10:1 -o "$T/x.stct")" = 2 ]
check "fixture_gen: a bad schedule, ES, jump, backlog, ahead, scatter (a floor without its level too), shift, freeze-pcr, no --trace or no -o exit 2" $?
# A backlog delays what was queued and keeps its stamps: the records, in order, arrive later.
"$GEN" --trace -o "$T/q0.stct" --seed 5 --duration 30 && "$GEN" --trace -o "$T/q1.stct" --seed 5 --duration 30 --backlog 10:3000:500 &&
    "$CLI" trace2jsonl "$T/q0.stct" | sed 's/"t":[0-9]*,//' >"$T/q0.v" && "$CLI" trace2jsonl "$T/q1.stct" | grep -v '"kind":"outage"' |
    sed 's/"t":[0-9]*,//' >"$T/q1.v" && cmp -s "$T/q0.v" "$T/q1.v" && "$CLI" trace2jsonl "$T/q1.stct" | grep -q '"kind":"outage"'
check "fixture_gen: --backlog moves arrivals only (the same records, an outage where the queue held them)" $?
# A bursty relay's per-second levels (B-100) move arrivals only; 0:MS draws as MS, the floor edge otherwise.
"$GEN" --trace -o "$T/s0.stct" --seed 5 --duration 30 --scatter-ms 200 &&
    "$GEN" --trace -o "$T/s1.stct" --seed 5 --duration 30 --scatter-ms 0:200 && cmp -s "$T/s0.stct" "$T/s1.stct" &&
    ! cmp -s "$T/q0.stct" "$T/s0.stct" && "$CLI" trace2jsonl "$T/s0.stct" | grep -v '"kind":"outage"' |
    sed 's/"t":[0-9]*,//' | cmp -s - "$T/q0.v" &&
    "$GEN" --trace -o "$T/s2.stct" --seed 5 --duration 30 --scatter-ms 50:250 --scatter-floor 40 &&
    ! cmp -s "$T/s0.stct" "$T/s2.stct"
check "fixture_gen: --scatter-ms moves arrivals only, 0:MS draws as MS; --scatter-floor draws a floor edge" $?
# --shift copies a recorded trace with one PID's PES stamped later: only those records differ, by the shift.
"$GEN" --shift 257:1000 -i "$T/q0.stct" -o "$T/sh.stct" && "$CLI" trace2jsonl "$T/q0.stct" >"$T/sh0.jsonl" &&
    "$CLI" trace2jsonl "$T/sh.stct" >"$T/sh1.jsonl" && [ "$(wc -l <"$T/sh0.jsonl")" -eq "$(wc -l <"$T/sh1.jsonl")" ] &&
    paste -d '\n' "$T/sh0.jsonl" "$T/sh1.jsonl" | awk 'NR % 2 { a = $0; next }
        a != $0 { n++; split(a, x, "\"pts\":"); split($0, y, "\"pts\":"); d = (y[2] + 0) - (x[2] + 0)
                  if (a !~ /"kind":"pes","pid":257,/ || (d != 90000 && d != 90000 - 8589934592)) bad++ }
        END { exit !(n > 100 && !bad) }' &&
    [ "$(status "$GEN" --shift 300:1000 -i "$T/q0.stct" -o "$T/x.stct")" = 1 ]
check "fixture_gen: --shift moves that PID's PES PTS alone, by the shift; a PID with no PES exits 1" $?
# --freeze-pcr (B-101) holds the PCRs arriving in its span at the first one's value: only those records differ.
"$GEN" --freeze-pcr 10:5 -i "$T/q0.stct" -o "$T/fz.stct" && "$CLI" trace2jsonl "$T/q0.stct" >"$T/fz0.jsonl" &&
    "$CLI" trace2jsonl "$T/fz.stct" >"$T/fz1.jsonl" && [ "$(wc -l <"$T/fz0.jsonl")" -eq "$(wc -l <"$T/fz1.jsonl")" ] &&
    paste -d '\n' "$T/fz0.jsonl" "$T/fz1.jsonl" | awk 'NR % 2 { a = $0; next }
        a != $0 { n++; split(a, x, "\"pcr\":"); split($0, y, "\"pcr\":"); split(y[2], v, ",")
                  if (a !~ /"kind":"pcr",/ || x[1] != y[1] || (n > 1 && v[1] != held)) bad++; held = v[1] }
        END { exit !(n >= 45 && n <= 50 && !bad) }' &&
    [ "$(status "$GEN" --freeze-pcr 100:1 -i "$T/q0.stct" -o "$T/x.stct")" = 1 ]
check "fixture_gen: --freeze-pcr holds the PCR at one value over its span, arrivals and PES kept; no PCR there exits 1" $?

# .stct -> JSONL -> .stct, every kind; through a pipe too.
"$CLI" trace2jsonl "$T/a.stct" >"$T/a.jsonl" && "$CLI" jsonl2trace "$T/a.jsonl" "$T/a2.stct" && cmp -s "$T/a.stct" "$T/a2.stct"
check "round trip: .stct -> trace2jsonl -> jsonl2trace is byte-identical" $?
grep -q '"kind":"outage"' "$T/a.jsonl" && grep -q '"kind":"psi"' "$T/a.jsonl" && grep -q '"di":true' "$T/a.jsonl" &&
    grep -q '"dtsMinusPts":-' "$T/a.jsonl"
check "round trip: the trace carries every kind, a flagged PCR and B-frame DTS" $?
"$CLI" trace2jsonl "$T/a.stct" | "$CLI" jsonl2trace - "$T/a3.stct" && cmp -s "$T/a.stct" "$T/a3.stct"
check "round trip: jsonl2trace reads stdin as -" $?

# Every field at its extremes, kinds and bits no recorder writes: lossless both ways.
cat >"$T/edge.jsonl" <<'EOF'
{"t":-9223372036854775808,"kind":"pcr","pid":65535,"pcr":18446744073709551615,"dtsMinusPts":-2147483648,"di":true,"class":3,"flagsRest":248}
{"t":9223372036854775807,"kind":"pes","pid":0,"pts":0,"dtsMinusPts":2147483647,"di":false,"class":"other"}
{"t":0,"kind":"psi","pid":8191,"program":65535,"streamType":255,"pcrPid":true,"valueRest":18446744069397807104,"di":false,"class":"audio"}
{"t":1,"kind":"outage","pid":8191,"silenceNs":3000000000,"di":false,"class":"other"}
{"t":2,"kind":7,"pid":256,"value":42,"di":true,"class":"video"}
{"t":3,"kind":0,"pid":1,"value":0,"di":false,"class":"other"}
EOF
"$CLI" jsonl2trace "$T/edge.jsonl" "$T/edge.stct" && "$CLI" trace2jsonl "$T/edge.stct" >"$T/edge2.jsonl" &&
    cmp -s "$T/edge.jsonl" "$T/edge2.jsonl" && [ "$(wc -c <"$T/edge.stct" | tr -d ' ')" -eq $((16 + 6 * 24)) ]
check "round trip: extreme values, unknown kinds and flag bits survive JSONL -> .stct -> JSONL" $?

# --- Version 2 (p5-6t, B-224): the sender's declaration. fixture_gen --decl is deterministic,
# bad values exit 2, and --sender-epoch makes the transit the path's delay.
DECL="--seed 5 --duration 30 --outage 10:1500 --decl 500:11:00000000000000ab --sender-epoch 50000"
# shellcheck disable=SC2086
"$GEN" --trace -o "$T/d.stct" $DECL && "$GEN" --trace -o "$T/d2.stct" $DECL && cmp -s "$T/d.stct" "$T/d2.stct" &&
    "$GEN" --trace -o "$T/d3.stct" --seed 5 --duration 30 --outage 10:1500 --decl 500:11 --sender-epoch 50000 &&
    ! cmp -s "$T/d.stct" "$T/d3.stct" && [ "$(od -An -tu1 -j4 -N1 "$T/d.stct" | tr -d ' ')" = 2 ]
check "fixture_gen --decl: the same arguments write the same version-2 bytes; another timeline_id other bytes" $?
all=0
for v in x -5 500:32 500:10:XYZ 500:10:00000000000000AB 500:10:00000000000000ab:0x0C \
    500:10:00000000000000ab:0x100 500:10:00000000000000ab:0xC0:1 47721858.9; do
    [ "$(status "$GEN" --trace -o "$T/x.stct" --decl "$v")" = 2 ] || { echo "  accepted --decl $v"; all=1; }
done
[ "$all" -eq 0 ] && [ "$(status "$GEN" --trace -o "$T/x.stct" --sender-epoch 50000 --sigma0 10)" = 2 ] &&
    [ "$(status "$GEN" --trace -o "$T/x.stct" --sender-epoch 50000 --wrap-at 5)" = 2 ] &&
    [ "$(status "$GEN" --trace -o "$T/x.stct" --sender-epoch -1)" = 2 ] &&
    [ "$(status "$GEN" --trace -o "$T/x.stct" --decl 0:255:ffffffffffffffff:0xF0)" = 0 ]
check "fixture_gen --decl: a bad D_e, class, timeline_id or flags, and --sender-epoch with --sigma0 or --wrap-at, exit 2" $?
"$CLI" trace2jsonl "$T/d.stct" >"$T/d.jsonl" && "$CLI" jsonl2trace "$T/d.jsonl" "$T/d4.stct" && cmp -s "$T/d.stct" "$T/d4.stct" &&
    recs=$(( ($(wc -c <"$T/d.stct") - 16) / 24 )) && decls=$(grep -c '"kind":"decl",' "$T/d.jsonl") &&
    [ "$decls" -gt 250 ] && [ "$(grep -c '"gmIdentity":"FF-FF-FF-FF-FF-FF-FF-FF","clockErrorClass":11,' "$T/d.jsonl")" -eq "$decls" ] &&
    [ "$(wc -l <"$T/d.jsonl" | tr -d ' ')" -eq $((recs - decls)) ] && ! grep -q '"kind":"decl2"' "$T/d.jsonl"
check "round trip v2: .stct -> trace2jsonl -> jsonl2trace byte-identical, one line per declaration pair" $?
# The first PCR: arrival + E_rx (50000 s - house0 1000 s) - (PCR + D_e 500 ms) = the 20 ms floor plus jitter.
grep -m 1 '"kind":"pcr"' "$T/d.jsonl" | awk '{ t = $0; sub(/.*"t":/, "", t); sub(/,.*/, "", t)
        p = $0; sub(/.*"pcr":/, "", p); sub(/,.*/, "", p)
        x = t + 49000e9 - (p * 1000 / 27 + 500e6); exit !(x >= 20e6 - 1000 && x <= 70e6) }'
check "fixture_gen --sender-epoch: the first PCR's transit is the path's delay" $?
"$CLI" restamp-replay "$T/d.stct" --quiet --trace-out "$T/d-again.stct" >"$T/d.out" && cmp -s "$T/d.stct" "$T/d-again.stct" &&
    grep -q '"faithful":true,' "$T/d.out" && grep -q '"misplaced":0,' "$T/d.out"
check "restamp-replay: a trace with declarations records again byte for byte (each into its PMT, repeats as repeats)" $?
# Every field of the pair at its extremes, an absent decl as written and with stray bits, a decl2 alone: lossless.
cat >"$T/dedge.jsonl" <<'EOF'
{"t":5,"kind":"decl","program":1,"present":false}
{"t":6,"kind":"decl","program":2,"present":true,"houseTimeTai":false,"disciplined":true,"traceable":false,"ptpValid":true,"timelineId":"ffffffffffffffff","de90k":4294967295,"hcVersion":255,"syncSource":3,"taiUtcOffsetS":255,"ptpDomain":0,"gmIdentity":"00-11-22-33-44-55-66-77","clockErrorClass":255,"epochSeq":65535}
{"t":7,"kind":"decl","program":65535,"present":false,"houseTimeTai":true,"disciplined":false,"traceable":false,"ptpValid":false,"timelineId":"0000000000000001","de90k":0,"flagsRest":14}
{"t":8,"kind":"decl","program":3,"present":true,"houseTimeTai":true,"disciplined":true,"traceable":true,"ptpValid":false,"timelineId":"0000000000000000","de90k":1}
{"t":9,"kind":"decl2","hcVersion":1,"syncSource":1,"taiUtcOffsetS":37,"ptpDomain":255,"gmIdentity":"FF-FF-FF-FF-FF-FF-FF-FF","clockErrorClass":10,"epochSeq":1}
EOF
"$CLI" jsonl2trace "$T/dedge.jsonl" "$T/dedge.stct" && "$CLI" trace2jsonl "$T/dedge.stct" >"$T/dedge2.jsonl" &&
    cmp -s "$T/dedge.jsonl" "$T/dedge2.jsonl" && [ "$(wc -c <"$T/dedge.stct" | tr -d ' ')" -eq $((16 + 6 * 24)) ]
check "round trip v2: declaration fields at their extremes, stray bits and a lone decl2 survive JSONL -> .stct -> JSONL" $?
# Version 1, every committed trace: read, replayed faithfully, and rewritten as version 2 with only the version changed.
n=0 bad=0
for f in "$FIX"/*.stct; do
    [ -e "$f" ] || continue
    n=$((n + 1))
    [ "$(od -An -tu1 -j4 -N1 "$f" | tr -d ' ')" = 1 ] && "$CLI" trace2jsonl "$f" >"$T/v1.jsonl" &&
        "$CLI" jsonl2trace "$T/v1.jsonl" "$T/v1.stct" && [ "$(cmp -l "$f" "$T/v1.stct" | tr -s ' ' | sed 's/^ //')" = "5 1 2" ] &&
        "$CLI" restamp-replay "$f" --quiet | grep -q '"faithful":true,' || { echo "  version 1: $f"; bad=$((bad + 1)); }
done
[ "$n" -ge 14 ] && [ "$bad" -eq 0 ]
check "version 1: the $n committed traces read, replay faithfully, and rewrite as version 2 differing in the version alone" $?
{ head -c 4 "$T/d.stct"; printf '\003'; tail -c +6 "$T/d.stct"; } >"$T/v3.stct"
"$CLI" trace2jsonl "$T/v3.stct" >"$T/v3.jsonl" 2>"$T/v3.err"
[ $? -eq 1 ] && [ ! -s "$T/v3.jsonl" ] && grep -q 'not an .stct trace of version 1 to 2' "$T/v3.err" &&
    [ "$(status "$CLI" restamp-replay "$T/v3.stct" --quiet)" = 1 ]
check "version 3: trace2jsonl and restamp-replay refuse the header" $?

# jsonl2trace refuses a bad line with its number, and writes nothing.
bad() {   # the JSONL line, the error expected on stderr
    printf '%s\n%s\n' '{"t":1,"kind":"pcr","pid":256,"pcr":1}' "$1" >"$T/bad.jsonl"
    rm -f "$T/bad.stct"
    "$CLI" jsonl2trace "$T/bad.jsonl" "$T/bad.stct" 2>"$T/bad.err" && return 1
    grep -q "bad.jsonl:2: $2" "$T/bad.err" && [ ! -e "$T/bad.stct" ]
}
bad '{"t":1,"kind":"pcr","pid":256,"pcr":1,"extra":0}' 'unknown key "extra"' &&
    bad '{"t":1,"kind":"pes","pid":256}' 'missing or bad "pts"' &&
    bad '{"t":1,"kind":"pcr","pid":65536,"pcr":1}' 'missing or bad "pid"' &&
    bad '{"t":1,"kind":"nope","pid":1,"value":1}' 'unknown kind' &&
    bad '{"t":1,"kind":"pes","pid":1,"pts":1,"dtsMinusPts":2147483648}' 'bad "dtsMinusPts"' &&
    bad '{"t":1.5,"kind":"pcr","pid":1,"pcr":1}' 'missing or bad "t"' &&
    bad '{"t":1,"kind":"pcr","pid":1,"pcr":1,"flagsRest":1}' 'bad "flagsRest"' &&
    bad '{"t":1,"kind":"pcr","pid":1,"pcr":1' "expected ',' or '}'"
check "jsonl2trace: a bad line exits 1 naming its line and the fault; no output file" $?
bad '{"t":1,"kind":"decl","program":1,"present":true}' 'missing or bad "houseTimeTai"' &&
    bad '{"t":1,"kind":"decl","program":1}' 'missing or bad "present"' &&
    bad '{"t":1,"kind":"decl","program":65536,"present":false}' 'missing or bad "program"' &&
    bad '{"t":1,"kind":"decl","program":1,"present":false,"epochSeq":1}' 'the decl2 fields are all given or none' &&
    bad '{"t":1,"kind":"decl2"}' 'a decl2 line needs its fields' &&
    bad '{"t":1,"kind":"decl","program":1,"present":false,"timelineId":"0x01"}' 'missing or bad "timelineId"' &&
    bad '{"t":1,"kind":"decl","program":1,"present":false,"flagsRest":1}' 'bad "flagsRest"' &&
    bad '{"t":1,"kind":"decl","program":1,"present":false,"pid":1}' 'unknown key "pid"' &&
    bad '{"t":1,"kind":"decl2","hcVersion":1,"syncSource":1,"taiUtcOffsetS":0,"ptpDomain":0,"gmIdentity":"nope","clockErrorClass":0,"epochSeq":0}' 'bad "gmIdentity"'
check "jsonl2trace: a bad declaration line exits 1 naming its line and the fault" $?

# trace2jsonl on damage: a cut file prints its whole records and exits 1, a file whose
# writer died (count 0) exits 0 with a note, a foreign file exits 1 printing nothing.
head -c $((16 + 24 * 10 + 7)) "$T/a.stct" >"$T/cut.stct"
"$CLI" trace2jsonl "$T/cut.stct" >"$T/cut.jsonl" 2>"$T/cut.err"
[ $? -eq 1 ] && [ "$(wc -l <"$T/cut.jsonl" | tr -d ' ')" -eq 10 ] && grep -q truncated "$T/cut.err"
check "trace2jsonl: a truncated trace prints its whole records, says so, exits 1" $?
{ head -c 8 "$T/a.stct"; printf '\000\000\000\000\000\000\000\000'; tail -c +17 "$T/a.stct"; } >"$T/open.stct"
"$CLI" trace2jsonl "$T/open.stct" >"$T/open.jsonl" 2>"$T/open.err" && cmp -s "$T/open.jsonl" "$T/a.jsonl" &&
    grep -q "never closed" "$T/open.err"
check "trace2jsonl: an unclosed trace (count 0) prints every record and exits 0" $?
printf 'not a trace at all' >"$T/junk.stct"
"$CLI" trace2jsonl "$T/junk.stct" >"$T/junk.jsonl" 2>/dev/null
[ $? -eq 1 ] && [ ! -s "$T/junk.jsonl" ]
check "trace2jsonl: a foreign file exits 1 and prints nothing" $?

# The replay: twice the same output, the trace it played recorded again exactly.
"$CLI" restamp-replay "$T/a.stct" --pes --trace-out "$T/again.stct" >"$T/r1.jsonl" &&
    "$CLI" restamp-replay "$T/a.stct" --pes >"$T/r2.jsonl" && cmp -s "$T/r1.jsonl" "$T/r2.jsonl"
check "restamp-replay: two runs print the same lines" $?
cmp -s "$T/a.stct" "$T/again.stct" && grep -q '"faithful":true' "$T/r1.jsonl"
check "restamp-replay: --trace-out writes the trace it played, byte for byte; the summary says faithful" $?
grep -q '"msg":"mrtsrestamp-stats"' "$T/r1.jsonl" && grep -q '"msg":"mrtsrestamp-pid"' "$T/r1.jsonl" &&
    grep -q '"msg":"mrtsrestamp-event","t":[0-9]*,"kind":"relock","program":1,"pid":-1,"reason":"discontinuity"' "$T/r1.jsonl" &&
    grep -q '"kind":"gap","program":1,"pid":256,"reason":"outage"' "$T/r1.jsonl" && grep -q '"msg":"pes"' "$T/r1.jsonl" &&
    [ "$(grep -c '"msg":"summary"' "$T/r1.jsonl")" -eq 1 ]
check "restamp-replay: the element's stats, PID and event lines (relock, outage gap), PES lines, one summary" $?
"$CLI" restamp-replay "$T/a.stct" --quiet --stats-interval-ms 500 >"$T/q.jsonl"
[ "$(wc -l <"$T/q.jsonl" | tr -d ' ')" -eq 1 ] && grep -q '"msg":"summary"' "$T/q.jsonl"
check "restamp-replay: --quiet prints the summary alone" $?
[ "$(status "$CLI" restamp-replay "$T/a.stct" --config no_such_knob=1)" = 2 ] &&
    [ "$(status "$CLI" restamp-replay "$T/a.stct" --config step_ns=x)" = 2 ] &&
    [ "$(status "$CLI" restamp-replay "$T/a.stct" --config mode=fixed add_base_time=1 base_time_ns=5 pid_trims='0x101=200000000;257=-1')" = 0 ] &&
    [ "$(status "$CLI" restamp-replay "$T/junk.stct")" = 1 ]
check "restamp-replay: an unknown or bad --config exits 2, a good one replays, a foreign file exits 1" $?
printf '{"step_ns": [10000000, 20000000], "pcr.rate_max_ppm": [1000]}\n' >"$T/grid.json"
"$CLI" restamp-replay "$T/a.stct" --sweep "$T/grid.json" >"$T/sweep.jsonl" &&
    [ "$(grep -c '"msg":"sweep",' "$T/sweep.jsonl")" -eq 2 ] && grep -q '"msg":"sweep-done","points":2' "$T/sweep.jsonl" &&
    grep -q '"config":{"step_ns":20000000,"pcr.rate_max_ppm":1000}' "$T/sweep.jsonl" &&
    [ "$(grep -c '"summary":{"program":1,"relocks":1,.*"ppbAtS":{}}}$' "$T/sweep.jsonl")" -eq 2 ]
check "restamp-replay: --sweep replays once per grid point, naming its config, with the program's summary" $?
# The summary's epsilon at the convergence marks the trace reaches (60 s of 61 here).
"$GEN" --trace -o "$T/m.stct" --duration 61 --pids v --seed 3 &&
    "$CLI" restamp-replay "$T/m.stct" --sweep "$T/grid.json" | grep -q '"ppbAtS":{"60":-\{0,1\}[0-9]*}}}$'
check "restamp-replay: a sweep line names epsilon at each convergence mark the trace reaches" $?
# The committed grid (WI-P1-6, plan part 4.3): every axis a knob, 243 points.
"$CLI" restamp-replay "$T/a.stct" --sweep "$FIX/sweep-grid.json" >"$T/grid243.jsonl" &&
    grep -q '"msg":"sweep-done","points":243' "$T/grid243.jsonl"
check "restamp-replay: the committed sweep-grid.json replays, 243 points" $?
printf '{"step_ns": [10000000], "bucket_nss": [1]}\n' >"$T/grid2.json"
[ "$(status "$CLI" restamp-replay "$T/a.stct" --sweep "$T/grid2.json")" = 1 ]
check "restamp-replay: a grid with an unknown key exits 1" $?
# A trace no recorder could write (an outage shorter than one) replays otherwise: said.
{ "$CLI" trace2jsonl "$T/a.stct" | head -n 200
  echo '{"t":1000500000000,"kind":"outage","pid":8191,"silenceNs":400000000,"di":false,"class":"other"}'; } >"$T/odd.jsonl"
"$CLI" jsonl2trace "$T/odd.jsonl" "$T/odd.stct" && "$CLI" restamp-replay "$T/odd.stct" --quiet >"$T/odd.out" &&
    grep -q '"faithful":false,"rerecorded":200,"firstDiff":200,"misplaced":1' "$T/odd.out"
check "restamp-replay: a replay that records otherwise than it played says where (faithful false)" $?
# The clock reads lost through an outage past lost_ns (5 s): the replay ticks it.
"$GEN" --trace -o "$T/long.stct" --outage 30:7000 --duration 60 --seed 9
"$CLI" restamp-replay "$T/long.stct" >"$T/long.out" && grep -q '"state":"lost"' "$T/long.out" &&
    [ "$(grep -c '"state":"lost"' "$T/long.out")" -le 2 ]
check "restamp-replay: a 7 s outage shows the clock lost on the stats lines inside it" $?

# Every expectation file: its trace (regenerated from "source" when it names fixture_gen
# and none is committed), replayed with the shipped constants.
n=0
for x in "$FIX"/*.expect.json; do
    [ -e "$x" ] || continue
    name=$(basename "$x" .expect.json)
    args=$(sed -n 's/^  "source": "fixture_gen \(.*\)",$/\1/p' "$x")
    trace=$FIX/$name.stct
    if [ -n "$args" ]; then
        # A derived trace's input (-i) is a committed trace beside the expectation.
        args=$(printf '%s' "$args" | sed "s| -i \([^ ]*\)| -i $FIX/\1|")
        # shellcheck disable=SC2086
        "$GEN" $args -o "$T/$name.stct"
        if [ -e "$trace" ]; then
            cmp -s "$trace" "$T/$name.stct"; check "$name: the committed trace is the generator's" $?
        fi
        trace=$T/$name.stct
    fi
    "$CLI" restamp-replay "$trace" --quiet --expect "$x" >"$T/$name.out"
    st=$?
    check "$name: $(tail -n 1 "$T/$name.out")" $st
    n=$((n + 1))
done
[ "$n" -ge 11 ]
check "expectations: $n files read (part 7.2's synthetic set at least)" $?
"$GEN" --trace -o "$T/disc.stct" --jump 60:30000:di --duration 120 --seed 21
"$CLI" restamp-replay "$T/disc.stct" --quiet --expect "$FIX/syn-outage-continuous-pcr.expect.json" >"$T/wrong.out"
[ $? -eq 1 ] && grep -q '"ok":false' "$T/wrong.out" && grep -q 'relocks: 1, want 0' "$T/wrong.out"
check "expectations: a trace against another's expectation fails, naming what differs" $?
printf '{"events": [{"kind": "gap", "reason": "epoch"}, {"kind": "relock", "reason": "discontinuity"}]}\n' >"$T/order.json"
printf '{"events": [{"kind": "relock", "reason": "discontinuity", "atS": [59.9, 60.3]}, {"kind": "gap", "pid": 257}]}\n' >"$T/order2.json"
[ "$(status "$CLI" restamp-replay "$T/disc.stct" --quiet --expect "$T/order.json")" = 1 ] &&
    [ "$(status "$CLI" restamp-replay "$T/disc.stct" --quiet --expect "$T/order2.json")" = 0 ]
check "expectations: events match in order (the gap after its relock), not anywhere" $?
# Every key bites: on the re-route trace (locked at ~38 s, a 20 ppm slew, the -30 ms fall
# leaving a residual of -30 ms, ~35 ms gaps, nothing dropped, the relock's PCR flagged, its PCR
# every 100 ms) each of these must fail.
r=$T/syn-reroute-30ms.stct
all=0
for want in '"residualMinMs": -1' '"lockedWithinS": 10' '"mappingPpmMax": 5' '"finalState": "degraded"' \
    '"cadenceWarning": true' '"gapMs": [0, 1]' '"droppedPes": 1' '"ppm": [100, 200]' '"monotonic": false' \
    '"faithful": false' '"epochs": 1' '"envelopeSteps": 0' '"recovered": 1' '"overlaps": 1' '"droppedMs": [1, 2]' \
    '"gapsPerPid": 2' '"relockReasons": ["leap"]' '"psiChanges": 0' '"program": 2' '"leadClamps": 1' '"leadMaxMs": 1' \
    '"backlogEvents": 1' '"pcrFlagged": 0' '"pcrCadenceMs": 1'; do
    printf '{%s}\n' "$want" >"$T/neg.json"
    [ "$(status "$CLI" restamp-replay "$r" --quiet --expect "$T/neg.json")" = 1 ] || { echo "  passed: $want"; all=1; }
done
[ "$all" -eq 0 ]
check "expectations: each key fails when the replay differs" $?
# --config reaches the clock: a two-sided step relocks on the fall too; a 50 ms step
# ignores the 30 ms rise.
printf '{"relocks": 2, "relockReasons": ["envelope-step", "envelope-step"]}\n' >"$T/two.json"
printf '{"relocks": 0, "envelopeSteps": 0}\n' >"$T/none.json"
[ "$(status "$CLI" restamp-replay "$r" --quiet --config step_falls=true --expect "$T/two.json")" = 0 ] &&
    [ "$(status "$CLI" restamp-replay "$r" --quiet --config clock.step_ns=50000000 --expect "$T/none.json")" = 0 ] &&
    [ "$(status "$CLI" restamp-replay "$r" --quiet --config pcr.step_ns=50000000)" = 2 ]
check "restamp-replay: --config sets the clock's constants (step_falls, clock.step_ns; pcr. has none)" $?

# --- rebase (WI-P3-3): every committed .ts moved +1 h and back, and onto the 2^33 wrap and back.
key() { sed -n "s/.*\"$1\":\(-\{0,1\}[0-9]*\).*/\1/p" "$2"; }   # a number from a rebase report
n=0 bad=0
for f in "$TSFIX"/*.ts; do
    [ -e "$f" ] || continue
    "$CLI" rebase "$f" "$T/r1.ts" --to-ns 5000000000000 >"$T/r1.json" || { bad=$((bad + 1)); continue; }
    from=$(key fromNs "$T/r1.json")
    "$CLI" rebase "$f" "$T/r2.ts" --to-ns $((from + 3600000000000)) >"$T/r2.json" &&
        [ "$(key shiftNs "$T/r2.json")" = 3600000000000 ] && [ "$(key shift90k "$T/r2.json")" = 324000000 ] &&
        "$CLI" rebase "$T/r2.ts" "$T/r3.ts" --to-ns "$from" >/dev/null && cmp -s "$f" "$T/r3.ts" &&
        ! cmp -s "$f" "$T/r2.ts" || { echo "  +1 h and back: $f"; bad=$((bad + 1)); }
    # The first PES 1 s before 2^33 on the bus (house = PES - 1 h): the stream crosses the wrap.
    wrap=$(( (8589934592 - 90000 - 324000000) * 100000 / 9 ))
    "$CLI" rebase "$f" "$T/w.ts" --to-ns "$wrap" >"$T/w.json" &&
        [ "$(key toNs "$T/w.json")" -le $((wrap + 50000)) ] && [ "$(key toNs "$T/w.json")" -ge $((wrap - 50000)) ] &&
        "$CLI" rebase "$T/w.ts" "$T/w2.ts" --to-ns "$from" >/dev/null && cmp -s "$f" "$T/w2.ts" ||
        { echo "  across 2^33 and back: $f"; bad=$((bad + 1)); }
    n=$((n + 1))
done
[ "$n" -ge 14 ] && [ "$bad" -eq 0 ]
check "rebase: $n committed .ts moved +1 h and back and across 2^33 and back, byte-identical; the first PES within 50 us of T" $?
# The dump of a rebased file: every PES PTS and DTS by the shift mod 2^33, a split header's too,
# every other field unchanged.
"$CLI" rebase "$TSFIX/syn-pes-header-split.ts" "$T/s.ts" --to-ns 7777777777777 >"$T/s.json" &&
    d=$(key shift90k "$T/s.json") && [ "$(key spans "$T/s.json")" = 72 ] && [ "$(key broken "$T/s.json")" = 0 ] &&
    "$CLI" dump "$TSFIX/syn-pes-header-split.ts" >"$T/s0.jsonl" && "$CLI" dump "$T/s.ts" >"$T/s1.jsonl" &&
    paste -d '\n' "$T/s0.jsonl" "$T/s1.jsonl" | awk -v d="$d" '
        function f(l, k,  x) { x = l; if (!sub(".*\"" k "\":", "", x)) return "-"; sub("[,}].*", "", x); return x }
        function cut(l) { gsub("\"(pts|dts|ptsUnwrapped|dtsUnwrapped)\":[-0-9a-z]*", "", l); return l }
        function moved(a, b) { return a == "null" ? b == "null" : (a + d) % 8589934592 + 0 == b + 0 }
        NR % 2 { a = $0; next }
        { n++; if (cut(a) != cut($0)) bad++; else if ($0 ~ /^\{"pid"/ && !(moved(f(a, "pts"), f($0, "pts")) && moved(f(a, "dts"), f($0, "dts")))) bad++ }
        END { exit !(n > 140 && !bad) }'
check "rebase: syn-pes-header-split's dump moved PES for PES by the shift (72 split headers), nothing else" $?
# The sidecar: pts by shiftNs exactly, every other field kept, and back again byte for byte.
"$CLI" rebase "$TSFIX/syn-gap-marker.ts" "$T/g.ts" --to-ns 123456789000000 --bus "$TSFIX/syn-gap-marker.bus.jsonl" "$T/g.bus.jsonl" >"$T/g.json" &&
    sh_ns=$(key shiftNs "$T/g.json") && [ "$(key busLines "$T/g.json")" = "$(wc -l <"$TSFIX/syn-gap-marker.bus.jsonl" | tr -d ' ')" ] &&
    paste -d '\n' "$TSFIX/syn-gap-marker.bus.jsonl" "$T/g.bus.jsonl" | awk -v d="$sh_ns" '
        NR % 2 { a = $0; next }
        { n++; x = a; y = $0; sub(".*\"pts\":", "", x); sub(",.*", "", x); sub(".*\"pts\":", "", y); sub(",.*", "", y)
          ra = a; rb = $0; sub("\"pts\":[0-9]*", "", ra); sub("\"pts\":[0-9]*", "", rb)
          if (ra != rb || x + d != y) bad++; if ($0 ~ /"flags":2112/) gaps++ }
        END { exit !(n > 400 && gaps == 2 && !bad) }' &&
    "$CLI" rebase "$T/g.ts" "$T/g2.ts" --to-ns "$(key fromNs "$T/g.json")" --bus "$T/g.bus.jsonl" "$T/g2.bus.jsonl" >/dev/null &&
    cmp -s "$TSFIX/syn-gap-marker.ts" "$T/g2.ts" && cmp -s "$TSFIX/syn-gap-marker.bus.jsonl" "$T/g2.bus.jsonl"
check "rebase --bus: the sidecar's pts moved by the shift in ns, its GAP|DISCONT markers and the rest kept; back again byte-identical" $?
{ head -n 2 "$TSFIX/syn-gap-marker.bus.jsonl"; echo '{"off":0,"len":188,"pts":1,"flags":0,"extra":1}'; } >"$T/bad.bus.jsonl"
echo '{"off":535000,"len":188,"pts":1,"flags":0}' >"$T/past.bus.jsonl"
echo '{"off":0,"len":188,"pts":1,"flags":0}' >"$T/early.bus.jsonl"
"$CLI" rebase "$TSFIX/syn-gap-marker.ts" "$T/x.ts" --to-ns 1 --bus "$T/bad.bus.jsonl" "$T/x.bus.jsonl" 2>"$T/bad.err"
[ $? -eq 1 ] && grep -q 'bad.bus.jsonl:3: unknown key "extra"' "$T/bad.err" &&
    [ "$(status "$CLI" rebase "$TSFIX/syn-gap-marker.ts" "$T/x.ts" --to-ns 1 --bus "$T/past.bus.jsonl" "$T/x.bus.jsonl")" = 1 ] &&
    [ "$(status "$CLI" rebase "$TSFIX/syn-gap-marker.ts" "$T/x.ts" --to-ns 0 --bus "$T/early.bus.jsonl" "$T/x.bus.jsonl")" = 1 ] &&
    [ "$(status "$CLI" rebase "$TSFIX/syn-gap-marker.ts" "$T/x.ts")" = 2 ] &&
    [ "$(status "$CLI" rebase "$TSFIX/syn-gap-marker.ts" "$T/x.ts" --to-ns 5x)" = 2 ] &&
    [ "$(status "$CLI" rebase "$TSFIX/syn-gap-marker.ts" --to-ns 5)" = 2 ] &&
    [ "$(status "$CLI" rebase "$T/junk.stct" "$T/x.ts" --to-ns 5)" = 1 ]
check "rebase: a bad sidecar line (named), a buffer past the end or before house time 0, no PES, a bad or missing --to-ns refused" $?

# --- Phase 3's --ts kinds and --respace (WI-P3-3): deterministic, the marker kind with its sidecar.
all=0
for k in gap-500ms gap-marker video-hole-1s private-novdesc pmt-version-bump adts-mpeg2; do
    "$GEN" --ts "$k" -o "$T/k1.ts" && "$GEN" --ts "$k" -o "$T/k2.ts" && cmp -s "$T/k1.ts" "$T/k2.ts" &&
        cmp -s "$T/k1.ts" "$TSFIX/syn-$k.ts" || { echo "  kind $k"; all=1; }
done
"$GEN" --ts gap-marker -o "$T/gm.ts" && cmp -s "$T/gm.bus.jsonl" "$TSFIX/syn-gap-marker.bus.jsonl" || all=1
[ "$all" -eq 0 ] && [ "$(status "$GEN" --ts gap-501ms -o "$T/x.ts")" = 2 ]
check "fixture_gen --ts: Phase 3's six kinds write the committed bytes, gap-marker its sidecar beside OUT; an unknown kind exits 2" $?
"$GEN" --respace 40 -i "$TSFIX/cap-mux-align7-aac-opus.ts" -o "$T/fc.ts" && cmp -s "$T/fc.ts" "$TSFIX/syn-foreign-clock-aac.ts" &&
    "$GEN" --respace -40 -i "$TSFIX/cap-mux-align7-aac-opus.ts" -o "$T/fc2.ts" && ! cmp -s "$T/fc.ts" "$T/fc2.ts" &&
    [ "$(status "$GEN" --respace 4x -i "$TSFIX/cap-mux-align7-aac-opus.ts" -o "$T/x.ts")" = 2 ] &&
    [ "$(status "$GEN" --respace 200000 -i "$TSFIX/cap-mux-align7-aac-opus.ts" -o "$T/x.ts")" = 2 ] &&
    [ "$(status "$GEN" --respace 40 -o "$T/x.ts")" = 2 ] &&
    [ "$(status "$GEN" --respace 40 -i "$T/junk.stct" -o "$T/x.ts")" = 1 ]
check "fixture_gen --respace: +40 ppm writes syn-foreign-clock-aac.ts, -40 another; a bad PPM, no -i or no PES refused" $?

# --- p5-5 (WI-P5-5, B-223): pcrcheck, hcdesc and dump --net on the writer's golden outputs.
EG=$TSFIX/egress
num() { sed -n "s/.*\"$1\":\(-\{0,1\}[0-9]*\).*/\1/p" "$2" | head -n 1; }   # a number's first match in a file
sum() { awk -F"\"$1\":" 'NF > 1 { split($2, a, ","); r += a[1] } END { print r + 0 }' "$2"; }   # over programs
# Every egress case through `mrts_cli egress --out`, then pcrcheck: five clean, the rest only their
# replay inputs' faults (sparse packets, CC errors carried, the replay clock's jumps at
# bus-pmt-change and gap-marker; row B-223). No timing PES is ever at its PCR.
all=0
while read -r name rep jumps cc viol; do
    clock=$EG/$name.clock.json
    in=$(sed -n 's/^ *"input": "\(.*\)",\{0,1\}$/\1/p' "$clock")
    bus=$(sed -n 's/^ *"bus": "\(.*\)",\{0,1\}$/\1/p' "$clock")
    if [ -n "$bus" ]; then
        "$CLI" egress "$TSFIX/$in" --clock "$clock" --bus "$TSFIX/$bus" --out "$T/$name.ts" >"$T/$name.eg"
    else
        "$CLI" egress "$TSFIX/$in" --clock "$clock" --out "$T/$name.ts" >"$T/$name.eg"
    fi || { echo "  egress $name"; all=1; continue; }
    "$CLI" pcrcheck "$T/$name.ts" >"$T/$name.pcr"
    st=$?
    got="$(sum pcrRepetitionErrors "$T/$name.pcr") $(sum pcrJumpsUnflagged "$T/$name.pcr")"
    got="$got $(tail -n 1 "$T/$name.pcr" | sed 's/.*"ccErrors":\([0-9]*\),"violations":\([0-9]*\)}$/\1 \2/')"
    rc=1
    [ "$viol" -eq 0 ] && rc=0
    { [ "$got" = "$rep $jumps $cc $viol" ] && [ "$(sum pesBeforePcr "$T/$name.pcr")" = 0 ] && [ "$st" -eq "$rc" ]; } ||
        { echo "  $name: got $got, want $rep $jumps $cc $viol (exit $st)"; all=1; }
    # One program, no gap marker: the widest interval is the writer's own figure (to 1 us of rounding).
    if [ "$name" != mpts-two-programs ] && [ "$name" != bus-ingest-relock-gap ]; then
        a=$(num intervalMaxNs "$T/$name.pcr") b=$(num pcrIntervalMaxNs "$T/$name.eg")
        [ $((a - b)) -le 1000 ] && [ $((b - a)) -le 1000 ] || { echo "  $name: interval $a, writer $b"; all=1; }
    fi
done <<'CASES'
302m-bssd 0 0 0 0
bus-ingest-relock-gap 23 0 30 53
bus-pmt-change 39 1 23 63
gap-marker 0 2 0 2
hevc-aac-max 96 0 0 96
mixer-302m-ptp 0 0 0 0
mpts-two-programs 0 0 128 128
mux-unbounded-video 0 0 0 0
occ-relay-unknown-e 0 0 0 0
pes-header-split 39 0 0 39
pmt-version-bump-reepoch 0 0 0 0
wrap-33bit 111 0 0 111
CASES
[ "$all" -eq 0 ] && [ "$(ls "$EG"/*.clock.json | wc -l)" -eq 12 ]
check "pcrcheck: the twelve golden outputs, five clean, the rest only their inputs' faults; no timing PES at its PCR" $?
grep -q '"pcrFlagged":2,.*"pcrJumpsUnflagged":0,"pcrJumpsFlagged":1,' "$T/pmt-version-bump-reepoch.pcr" &&
    grep -q '"untimedBeforePcr":3,' "$T/occ-relay-unknown-e.pcr" && grep -q '{"pid":32,"timing":false,' "$T/occ-relay-unknown-e.pcr" &&
    grep -q '"intervalHistMs":{"10":1,"20":10,"30":0,"35":0,"40":20,"100":0}' "$T/mux-unbounded-video.pcr"
check "pcrcheck: a re-epoch's flagged jump is no violation; a late teletext counts apart; the interval histogram" $?
# The hand-made unflagged jump: the clean output cut at a packet, its tail rebased 1 s later (PCR and
# PTS alike, CC kept), joined again: one jump, nothing else. 1 s earlier: one too.
g=$T/mux-unbounded-video.ts
head -c $((5000 * 188)) "$g" >"$T/j-head.ts" && tail -c +$((5000 * 188 + 1)) "$g" >"$T/j-tail.ts" &&
    "$CLI" rebase "$T/j-tail.ts" "$T/j-x.ts" --to-ns 1 >"$T/j.json" && f0=$(key fromNs "$T/j.json") &&
    "$CLI" rebase "$T/j-tail.ts" "$T/j-late.ts" --to-ns $((f0 + 1000000000)) >/dev/null &&
    "$CLI" rebase "$T/j-tail.ts" "$T/j-early.ts" --to-ns $((f0 - 1000000000)) >/dev/null &&
    cat "$T/j-head.ts" "$T/j-late.ts" >"$T/jump.ts" && cat "$T/j-head.ts" "$T/j-early.ts" >"$T/jump2.ts"
"$CLI" pcrcheck "$T/jump.ts" >"$T/jump.pcr"
st=$?
"$CLI" pcrcheck "$T/jump2.ts" >"$T/jump2.pcr"
st2=$?
[ "$st" -eq 1 ] && [ "$st2" -eq 1 ] && grep -q '"pcrJumpsUnflagged":1,"pcrJumpsFlagged":0,' "$T/jump.pcr" &&
    grep -q '"pcrJumpsUnflagged":1,"pcrJumpsFlagged":0,' "$T/jump2.pcr" &&
    [ "$(tail -n 1 "$T/jump.pcr" | sed 's/.*"violations":\([0-9]*\)}$/\1/')" = 1 ] &&
    [ "$(tail -n 1 "$T/jump2.pcr" | sed 's/.*"violations":\([0-9]*\)}$/\1/')" = 1 ] &&
    a=$(num jumpMaxNs "$T/jump.pcr") && [ "$a" -gt 1000000000 ] && [ "$a" -lt 1100000000 ] &&
    a=$(num jumpMaxNs "$T/jump2.pcr") && [ "$a" -gt -1000000000 ] && [ "$a" -lt -900000000 ] &&
    grep -q '"pcrJumpsFlagged":0,"jumpMaxNs":null,' "$T/mux-unbounded-video.pcr"
check "pcrcheck: a hand-made unflagged PCR jump (+1 s, and -1 s) is one violation, exit 1, its size in jumpMaxNs" $?
# pcr_at IN OUT K ADD: the K-th PCR on PID 256 set ADD (90 kHz) after the lowest DTS (else PTS) of the
# timing PES from its packet to the next PCR; prints how many of those it leaves at or behind it.
pcr_at() {
    set -- "$1" "$2" "$(od -An -v -tu1 -w188 "$1" | awk -v k="$3" -v add="$4" '
        function ts(i) { return (int($(i) / 2) % 8) * 1073741824 + $(i + 1) * 4194304 + int($(i + 2) / 2) * 32768 + $(i + 3) * 128 + int($(i + 4) / 2) }
        $1 != 71 { next }
        { pid = ($2 % 32) * 256 + $3; afc = int($4 / 16) % 4 }
        pid == 256 && afc >= 2 && $5 > 0 && int($6 / 16) % 2 == 1 { n++; if (n == k) at = NR - 1; else if (n == k + 1) exit }
        n == k && afc % 2 == 1 && int($2 / 64) % 2 == 1 {
            o = 4 + (afc >= 2 ? 1 + $5 : 0) + 1; sid = $(o + 3); pd = int($(o + 7) / 64)
            if ($o != 0 || $(o + 1) != 0 || $(o + 2) != 1 || pd < 2 || (pid != 256 && (sid < 192 || sid > 239))) next
            v[++m] = pd == 3 ? ts(o + 14) : ts(o + 9)
        }
        END {
            lo = v[1]; for (i = 2; i <= m; i++) if (v[i] < lo) lo = v[i]
            b = (lo + add) % 8589934592; c = 0
            for (i = 1; i <= m; i++) if (v[i] <= lo + add) c++
            printf "%d %d %d %d %d %d %d\n", at, c, int(b / 33554432), int(b / 131072) % 256, int(b / 512) % 256, int(b / 2) % 256, (b % 2) * 128 + 126 }')"
    cp "$1" "$2" && set -- "$2" $3 &&
        printf "\\$(printf %o "$4")\\$(printf %o "$5")\\$(printf %o "$6")\\$(printf %o "$7")\\$(printf %o "$8")\\000" |
        dd of="$1" bs=1 seek=$(($2 * 188 + 6)) conv=notrunc 2>/dev/null && echo "$3"
}
# One PCR moved 1 s late: its window's timing PES are behind it, counted as such (chapter 9's
# "must stay > 0"); one moved onto the lowest DTS-or-PTS: that PES, exactly at it, counts too.
c=$(pcr_at "$g" "$T/late.ts" 10 90000) && "$CLI" pcrcheck "$T/late.ts" >"$T/late.pcr"
st=$?
c2=$(pcr_at "$g" "$T/at.ts" 10 0) && "$CLI" pcrcheck "$T/at.ts" >"$T/at.pcr"
st2=$?
[ "$st" -eq 1 ] && [ "$st2" -eq 1 ] && [ "$c" -ge 2 ] && [ "$c2" -ge 1 ] &&
    grep -q "\"pesBeforePcr\":$c,\"untimedBeforePcr\":0," "$T/late.pcr" &&
    grep -q '{"pid":264,"timing":true,"pes":37,"ptsMinusPcrMinNs":-1000000000,' "$T/late.pcr" &&
    grep -q "\"pesBeforePcr\":$c2,\"untimedBeforePcr\":0," "$T/at.pcr" &&
    grep -q '{"pid":264,"timing":true,"pes":37,"ptsMinusPcrMinNs":0,' "$T/at.pcr" &&
    grep -q '{"pid":256,"timing":true,"pes":21,"ptsMinusPcrMinNs":124326333,"dtsMinusPcrMinNs":110998777}' "$T/at.pcr" &&
    [ "$(num jumpMaxNs "$T/late.pcr")" -gt 1000000000 ] && [ "$(num jumpMaxNs "$T/at.pcr")" -gt 100000000 ]
check "pcrcheck: timing PES behind their PCR, and one exactly at it, are counted as late, exit 1; the per-PID minimum; the larger of two jumps" $?
# --arrival: a path without jitter is flat, one with it is not, a slow source drifts; a jump starts a run.
"$GEN" --trace -o "$T/ar0.stct" --duration 60 --seed 3 --jitter-ms 0 &&
    "$GEN" --trace -o "$T/ar5.stct" --duration 60 --seed 3 --jitter-ms 5 &&
    "$GEN" --trace -o "$T/arp.stct" --duration 60 --seed 3 --jitter-ms 0 --ppm -300 &&
    "$GEN" --trace -o "$T/arj.stct" --duration 60 --seed 3 --jitter-ms 0 --jump 30:-5000:di &&
    "$CLI" pcrcheck "$g" --arrival "$T/ar0.stct" >"$T/ar0.pcr" &&
    grep -q '"arrival","pid":256,"pcrs":600,"matched":0,"runs":1,"jitterPpNs":0,"detrendedPpNs":0,"driftPpb":0}' "$T/ar0.pcr" &&
    "$CLI" pcrcheck "$g" --arrival "$T/ar5.stct" | grep '"arrival"' >"$T/ar5.pcr" && [ "$(num detrendedPpNs "$T/ar5.pcr")" -gt 5000000 ] &&
    "$CLI" pcrcheck "$g" --arrival "$T/arp.stct" | grep -q '"jitterPpNs":17970000,"detrendedPpNs":0,"driftPpb":300000}' &&
    "$CLI" pcrcheck "$g" --arrival "$T/arj.stct" | grep -q '"runs":2,"jitterPpNs":0,'
check "pcrcheck --arrival: flat without jitter, jitter seen, a -300 ppm source's drift, a jump starts a run" $?
# The capture's own PCRs as a trace (one per ms of packet index): every one matches.
od -An -v -tu1 -w188 "$T/pes-header-split.ts" | awk '
    $1 == 71 && int($4 / 16) % 4 >= 2 && $5 > 0 && int($6 / 16) % 2 == 1 {
        b = $7 * 33554432 + $8 * 131072 + $9 * 512 + $10 * 2 + int($11 / 128)
        printf "{\"t\":%d,\"kind\":\"pcr\",\"pid\":%d,\"pcr\":%.0f,\"di\":%s,\"class\":\"video\"}\n",
            (NR - 1) * 1000000, ($2 % 32) * 256 + $3, b * 300 + ($11 % 2) * 256 + $12, $6 >= 128 ? "true" : "false" }' >"$T/own.jsonl" &&
    "$CLI" jsonl2trace "$T/own.jsonl" "$T/own.stct" && n=$(wc -l <"$T/own.jsonl" | tr -d ' ') && [ "$n" -gt 50 ] &&
    "$CLI" pcrcheck "$T/pes-header-split.ts" --arrival "$T/own.stct" | grep -q "\"arrival\",\"pid\":256,\"pcrs\":$n,\"matched\":$n,"
check "pcrcheck --arrival: a trace of the capture's own PCRs matches every one" $?
# Damage: a PMT with a broken CRC, a lost packet; a clean input exits 0; usage.
cp "$TSFIX/syn-gap-marker.ts" "$T/crc.ts" &&
    pk=$(od -An -v -tu1 -w188 "$T/crc.ts" | awk '$1 == 71 && ($2 % 32) * 256 + $3 == 4096 { print NR - 1; exit }') &&
    printf '\377' | dd of="$T/crc.ts" bs=1 seek=$((pk * 188 + 20)) conv=notrunc 2>/dev/null
"$CLI" pcrcheck "$T/crc.ts" >"$T/crc.pcr"
[ $? -eq 1 ] && grep -q '"pmtCrcErrors":1,"pids"' "$T/crc.pcr" && grep -q '"violations":1}$' "$T/crc.pcr" &&
    "$GEN" --drop 258@40 -i "$TSFIX/syn-gap-marker.ts" -o "$T/drop.ts" && "$CLI" pcrcheck "$T/drop.ts" >"$T/drop.pcr"
[ $? -eq 1 ] && grep -q '"ccErrors":1,"pmtSections"' "$T/drop.pcr" &&
    "$CLI" pcrcheck "$TSFIX/syn-gap-marker.ts" >/dev/null &&
    [ "$(status "$CLI" pcrcheck)" = 2 ] && [ "$(status "$CLI" pcrcheck "$g" --bogus)" = 2 ] &&
    [ "$(status "$CLI" pcrcheck "$T/none.ts")" = 3 ] && [ "$(status "$CLI" pcrcheck "$g" --arrival "$T/junk.stct")" = 3 ] &&
    head -c 20 "$T/ar0.stct" >"$T/cut.stct" && [ "$(status "$CLI" pcrcheck "$g" --arrival "$T/cut.stct")" = 3 ]
check "pcrcheck: a PMT CRC error and a lost packet are violations; a clean input exits 0; usage 2, a missing file or bad or cut trace 3" $?
# No capture is no clean one: an empty file, one of no PAT; a PAT CRC error; a program with PES and no PCR.
: >"$T/empty.ts" && awk 'BEGIN { for (i = 0; i < 1880; i++) printf "%c", 97 + i % 26 }' >"$T/nopat.ts" &&
    cp "$TSFIX/syn-gap-marker.ts" "$T/pat.ts" &&
    pk=$(od -An -v -tu1 -w188 "$T/pat.ts" | awk '$1 == 71 && ($2 % 32) * 256 + $3 == 0 { print NR - 1; exit }') &&
    printf '\377' | dd of="$T/pat.ts" bs=1 seek=$((pk * 188 + 15)) conv=notrunc 2>/dev/null &&
    "$GEN" --ts egress --pcr-pid none -o "$T/nopcr.ts" &&
    [ "$(status "$CLI" pcrcheck "$T/empty.ts")" = 1 ] && [ "$(status "$CLI" pcrcheck "$T/nopat.ts")" = 1 ] &&
    "$CLI" pcrcheck "$T/empty.ts" | grep -q '"packets":0,.*"programs":0,.*"violations":1}$' &&
    "$CLI" pcrcheck "$T/nopat.ts" | grep -q '"programs":0,.*"violations":1}$' &&
    [ "$(status "$CLI" pcrcheck "$T/pat.ts")" = 1 ] && "$CLI" pcrcheck "$T/pat.ts" | grep -q '"patCrcErrors":1,.*"violations":1}$' &&
    "$CLI" pcrcheck "$T/nopcr.ts" >"$T/nopcr.pcr"
[ $? -eq 1 ] && grep -q '"pcrs":0,.*"pesBeforePcr":0,.*"violations":1}$' "$T/nopcr.pcr" && grep -q '"violations":1}$' "$T/nopcr.pcr"
check "pcrcheck: an empty or PAT-less capture is a violation, as are a PAT CRC error and a program with PES and no PCR" $?
# --arrival: a PCR repeated (0 ms on) stays in its run.
for v in 0:0 33333333:900000 34000000:900000 66666666:1800000; do
    echo "{\"t\":${v%%:*},\"kind\":\"pcr\",\"pid\":256,\"pcr\":${v#*:},\"di\":false,\"class\":\"video\"}"
done >"$T/rep.jsonl" && "$CLI" jsonl2trace "$T/rep.jsonl" "$T/rep.stct" &&
    "$CLI" pcrcheck "$g" --arrival "$T/rep.stct" | grep -q '"arrival","pid":256,"pcrs":4,"matched":0,"runs":1,'
check "pcrcheck --arrival: a repeated PCR does not split its run" $?
# hcdesc: the re-epoch case's six PMT states, its timeline_id once set; none in an input of no writer.
"$CLI" hcdesc "$T/pmt-version-bump-reepoch.ts" >"$T/hc.jsonl" &&
    [ "$(grep '"hcdesc":"pmt"' "$T/hc.jsonl" | sed 's/.*"version":\([0-9]*\),.*/\1/' | paste -sd' ' -)" = "0 1 2 3 4 5" ] &&
    grep -q '"version":1,"mrht":{"hcVersion":1,"houseTimeTai":true,.*"epochSeq":3,"dE90k":14400,"dENs":160000000,"timelineId":"0000000000000000"}}$' "$T/hc.jsonl" &&
    grep -q '"version":2,.*"epochSeq":4,' "$T/hc.jsonl" &&
    grep -q '"version":4,.*"timelineId":"0123456789abcdef"}}$' "$T/hc.jsonl" &&
    grep -q '"gmIdentity":"FF-FF-FF-FF-FF-FF-FF-FF"' "$T/hc.jsonl" &&
    grep -q '^{"hcdesc":"summary","pmtSections":20,"pmtCrcErrors":0,"withMrht":20,"lines":6}$' "$T/hc.jsonl" &&
    "$CLI" hcdesc "$TSFIX/syn-pmt-version-bump.ts" >"$T/hc0.jsonl" && grep -q '"mrht":null}$' "$T/hc0.jsonl" &&
    ! grep -q '"mrht":{' "$T/hc0.jsonl" && grep -q '"withMrht":0,' "$T/hc0.jsonl" &&
    [ "$("$CLI" hcdesc "$T/mpts-two-programs.ts" | grep '"mrht":{' | sed 's/.*"program":\([0-9]*\),.*/\1/' | sort -u | paste -sd' ' -)" = "1 2" ] &&
    [ "$(status "$CLI" hcdesc)" = 2 ] && [ "$(status "$CLI" hcdesc "$T/none.ts")" = 3 ]
check "hcdesc: every PMT state with its version, the epoch and timeline_id as set; null without a writer; both MPTS programs; usage; a missing file 3" $?
# dump --net: the writer's output mapped back at the clock's E is the bus input's PTS and DTS, PES for PES.
"$CLI" dump "$TSFIX/cap-mux-unbounded-video.ts" |
    sed -n 's/^{"pid":\([0-9]*\),"sid":[0-9]*,"pts":\([0-9a-z]*\),"dts":\([0-9a-z]*\),.*/\1 \2 \3/p' >"$T/nb.txt" &&
    "$CLI" dump --net 1760283215123456789 "$g" |
    sed -n 's/^{"pid":\([0-9]*\),.*"ptsBus":\([0-9a-z]*\),"dtsBus":\([0-9a-z]*\),.*/\1 \2 \3/p' >"$T/nw.txt" &&
    [ "$(wc -l <"$T/nb.txt")" -gt 50 ] && grep -q ' [0-9]* [0-9]' "$T/nb.txt" && cmp -s "$T/nb.txt" "$T/nw.txt" &&
    ! "$CLI" dump "$g" | grep -q ptsBus &&
    [ "$(status "$CLI" dump --net 12x "$g")" = 2 ] && [ "$(status "$CLI" dump --net)" = 2 ]
check "dump --net: the writer's output at its E maps back to the bus input's PTS and DTS, PES for PES; none without it; a bad E exits 2" $?

echo
if [ "$fails" -ne 0 ]; then
    echo "$fails FAILURE(S) in trace_cli"
    exit 1
fi
echo "ALL trace_cli TESTS PASSED"
