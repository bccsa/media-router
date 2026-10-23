#!/bin/sh
# trace_cli_test: the arrival-trace tools at the command line (WI-P1-2): generator and replay
# determinism, the .stct <-> JSONL round trip, every expectation in tests/fixtures/restamp (a
# synthetic trace regenerated from its "source" line), bad input refused; check.h's output.
#   MRTS_CLI, FIXTURE_GEN, RESTAMP_FIXTURES override the default paths.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
CLI=${MRTS_CLI:-$HERE/../mrts_cli}
GEN=${FIXTURE_GEN:-$HERE/fixture_gen}
FIX=${RESTAMP_FIXTURES:-$HERE/../../../tests/fixtures/restamp}
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
    [ "$(status "$GEN" --shift 257:x -i "$T/a.stct" -o "$T/x.stct")" = 2 ] &&
    [ "$(status "$GEN" --shift 9000:100 -i "$T/a.stct" -o "$T/x.stct")" = 2 ] &&
    [ "$(status "$GEN" --shift 257:100 -o "$T/x.stct")" = 2 ]
check "fixture_gen: a bad schedule, ES, jump, backlog, ahead, scatter, shift, no --trace or no -o exit 2" $?
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

echo
if [ "$fails" -ne 0 ]; then
    echo "$fails FAILURE(S) in trace_cli"
    exit 1
fi
echo "ALL trace_cli TESTS PASSED"
