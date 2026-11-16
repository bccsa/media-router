#!/bin/sh
# Third-party receivers against the egress writer (plan ch. 9 WI-P5-15, V-P5-6, register B-252).
# `egress-compat.sh --help` for the commands; tools/egress-compat/README.md for the runs and verdicts.

set -u
SELF=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
ROOT=$(cd "$(dirname "$0")/.." && pwd)

die() { echo "egress-compat: $*" >&2; exit 2; }
up() { read -r u _ < /proc/uptime; echo "$u"; }
# Each line prefixed by uptime seconds: builtins only, so a burst of errors costs no forks.
stamp() { while IFS= read -r l; do read -r u _ < /proc/uptime; printf '%s %s\n' "$u" "$l"; done; }
ev() { echo "$(up) $1 $2" >> "$OUT/events.log"; }

usage() {
    cat <<'EOF_USAGE'
Third-party receivers against the egress writer (plan ch. 9 WI-P5-15, V-P5-6, register B-252).
Receives one egress for a set time, fans it to ffmpeg, VLC and stock tsdemux ! decodebin3 on
loopback, captures it for `mrts_cli pcrcheck`, fires the D_e raise and re-epoch hooks and judges.

  egress-compat.sh run --kind KIND [--port N] [--host H] [--out DIR] [options]   (dev Pi)
  egress-compat.sh dry-run --kind KIND [options]   (a local sender on the dev Pi, hooks built in)
  egress-compat.sh mark --out DIR NAME   (an event injected by hand, from now)
  egress-compat.sh report --out DIR   (judge a finished run again)
  egress-compat.sh selftest   (the judging over synthetic logs)
  egress-compat.sh runners | stall -p PID [-s SECONDS]   (on the box: BusyBox sh)

KIND is the box's output: srt-caller, srt-listener, udp, rtp, rist (box calls), rist-listener.
Options: --duration S (1800) --raise-at S (600) --reepoch-at S (1200) --raise-cmd CMD
  --reepoch-cmd CMD --window S (10) --grace S (10) --restarts N (0) --latency MS (srt, 200)
  --buffer MS (rist, 1000) --profile N (rist, 1) --iface IF (multicast) --fan-port N (15100)
  --players ffmpeg,vlc,gst --mrts-cli PATH. EGRESS_COMPAT_SECRET: SRT passphrase or RIST secret.
Event times count from the run's start. tools/egress-compat/README.md has the runs and verdicts.
EOF_USAGE
}

# --- the box side (BusyBox) ---------------------------------------------------------------

box_runners() {
    for d in /proc/[0-9]*; do
        c=$({ tr '\0' ' ' < "$d/cmdline"; } 2>/dev/null) || continue
        case "$c" in *mr-gst-runner*|*gst-pipeline-runner.py*) ;; *) continue ;; esac
        echo "${d#/proc/} $(cat "$d"/task/*/comm 2>/dev/null | sort -u | tr '\n' ' ')"
    done
}

box_stall() {
    PID="" SEC=1.5
    while [ $# -gt 0 ]; do
        case "$1" in -p) PID=$2; shift 2 ;; -s) SEC=$2; shift 2 ;; *) die "stall: unknown $1" ;; esac
    done
    [ -n "$PID" ] && [ -d "/proc/$PID" ] || die "stall: no process $PID"
    # A dropped session or an interrupt never leaves the runner stopped.
    trap 'kill -CONT "$PID" 2>/dev/null' EXIT
    trap 'exit 130' INT TERM HUP
    kill -STOP "$PID" || exit 1
    # BusyBox sleep takes fractions only when built with them: usleep otherwise. In the
    # background, so a signal runs the trap at once.
    us=$(awk -v s="$SEC" 'BEGIN { printf "%d", s * 1000000 }')
    if { sleep "$SEC" 2>/dev/null & wait $!; } || { usleep "$us" 2>/dev/null & wait $!; }; then
        kill -CONT "$PID"
        echo "stalled $PID for $SEC s"
    else
        kill -CONT "$PID"
        echo "stall: neither sleep $SEC nor usleep worked; $PID resumed at once" >&2
        exit 1
    fi
}

# --- options -------------------------------------------------------------------------------

KIND="" PORT="" HOST="" OUT="" DUR=1800 RAISE_AT=600 REEPOCH_AT=1200 RAISE_CMD="" REEPOCH_CMD=""
WINDOW=10 GRACE=10 RESTARTS=0 LAT=200 BUF=1000 PROFILE=1 IFACE="" FAN=15100 PLAYERS=ffmpeg,vlc,gst
MRTS_CLI="" ON_EXIT=:
parse() {
    while [ $# -gt 0 ]; do
        [ $# -ge 2 ] || die "$1 needs a value"
        case "$1" in
            --kind) KIND=$2 ;; --port) PORT=$2 ;; --host) HOST=$2 ;; --out) OUT=$2 ;;
            --duration) DUR=$2 ;; --raise-at) RAISE_AT=$2 ;; --reepoch-at) REEPOCH_AT=$2 ;;
            --raise-cmd) RAISE_CMD=$2 ;; --reepoch-cmd) REEPOCH_CMD=$2 ;; --window) WINDOW=$2 ;;
            --grace) GRACE=$2 ;; --restarts) RESTARTS=$2 ;; --latency) LAT=$2 ;; --buffer) BUF=$2 ;;
            --profile) PROFILE=$2 ;; --iface) IFACE=$2 ;; --fan-port) FAN=$2 ;;
            --players) PLAYERS=$2 ;; --mrts-cli) MRTS_CLI=$2 ;;
            *) die "unknown option $1" ;;
        esac
        shift 2
    done
    case "$KIND" in srt-caller|srt-listener|udp|rtp|rist|rist-listener) ;; *) die "--kind: '$KIND'" ;; esac
    [ -n "$PORT" ] || PORT=5000
    [ -n "$OUT" ] || OUT=$PWD/egress-compat-$KIND-$(date +%Y%m%d-%H%M%S)
    case "$OUT" in *' '*) die "--out: no spaces" ;; esac
    [ -n "$MRTS_CLI" ] || MRTS_CLI=$ROOT/plugins/mpegts-core/native/mrts/mrts_cli
    [ -x "$MRTS_CLI" ] || MRTS_CLI=$(command -v mrts_cli || echo "$MRTS_CLI")
}

# --- the receiving end ---------------------------------------------------------------------

frontend_src() {
    s=${EGRESS_COMPAT_SECRET:-}
    case "$KIND" in
        srt-caller) echo "srtsrc uri=\"srt://:$PORT?mode=listener&latency=$LAT\" keep-listening=true${s:+ passphrase=\"\$EGRESS_COMPAT_SECRET\"}" ;;
        srt-listener) echo "srtsrc uri=\"srt://$HOST:$PORT?mode=caller&latency=$LAT\"${s:+ passphrase=\"\$EGRESS_COMPAT_SECRET\"}" ;;
        udp|rtp)
            m=""
            [ -n "$HOST" ] && m=" address=$HOST auto-multicast=true${IFACE:+ multicast-iface=$IFACE}"
            if [ "$KIND" = udp ]; then
                echo "udpsrc port=$PORT$m buffer-size=4194304 caps=\"video/mpegts,systemstream=(boolean)true\""
            else
                echo "udpsrc port=$PORT$m buffer-size=4194304 caps=\"application/x-rtp,media=video,clock-rate=90000,encoding-name=MP2T,payload=33\" ! rtpjitterbuffer latency=200 ! rtpmp2tdepay"
            fi ;;
        rist) echo "mrristsrc urls=\"rist://@0.0.0.0:$PORT\" profile=$PROFILE buffer=$BUF${s:+ secret=\"\$EGRESS_COMPAT_SECRET\"}" ;;
        rist-listener) echo "mrristsrc urls=\"rist://$HOST:$PORT\" profile=$PROFILE buffer=$BUF${s:+ secret=\"\$EGRESS_COMPAT_SECRET\"}" ;;
    esac
}

# A player reads the fan-out on loopback port FAN+N; words split with globbing off.
player_cmd() {
    p=$((FAN + $2))
    case "$1" in
        ffmpeg) echo "ffmpeg -hide_banner -nostdin -loglevel level+warning -progress $OUT/ffmpeg.progress -stats_period 5 -i udp://127.0.0.1:$p?fifo_size=100000&overrun_nonfatal=1&buffer_size=4194304 -map 0:v? -map 0:a? -f null -" ;;
        vlc) echo "cvlc -I dummy --vout=dummy --aout=dummy --no-osd udp://@127.0.0.1:$p" ;;
        gst) echo "env GST_DEBUG=*:1 $LB gst-launch-1.0 -m udpsrc port=$p buffer-size=4194304 caps=video/mpegts,systemstream=(boolean)true ! tsdemux name=d d. ! queue ! decodebin3 ! fakesink name=sink-a sync=false d. ! queue ! decodebin3 ! fakesink name=sink-b sync=false" ;;
    esac
}

# Restarts the command until .stop, every line stamped into LOG; an exit is a judged line.
supervise() {
    name=$1 log=$2
    shift 2
    while [ ! -e "$OUT/.stop" ]; do
        sh -c 'echo $$ > "$0"; exec "$@"' "$OUT/$name.pid" "$@" 2>&1 | stamp >> "$log"
        [ -e "$OUT/.stop" ] && break
        echo "$(up) EGRESS-COMPAT exit: $name ended before the run did" >> "$log"
        sleep 1
    done
}

hook() {
    name=$1 at=$2 cmd=$3
    sleep "$at"
    [ -e "$OUT/.stop" ] && return
    if [ -z "$cmd" ]; then
        echo "egress-compat: inject the $name now, then: $SELF mark --out $OUT $name" >&2
        ev "$name" due
        return
    fi
    ev "$name" start
    sh -c "$cmd" >> "$OUT/hooks.log" 2>&1
    echo "$(up) $name hook rc=$?" >> "$OUT/hooks.log"
    ev "$name" end
}

stop_all() {
    touch "$OUT/.stop"
    [ -e "$OUT/frontend.pid" ] && kill -INT "$(cat "$OUT/frontend.pid")" 2>/dev/null
    for f in "$OUT"/*.pid; do [ -e "$f" ] && kill "$(cat "$f")" 2>/dev/null; done
    sleep 3
    for f in "$OUT"/*.pid; do [ -e "$f" ] && kill -9 "$(cat "$f")" 2>/dev/null; done
    rm -f "$OUT"/*.pid
}

run_body() {
    case "$KIND" in *-listener) [ -n "$HOST" ] || die "--host: the box, for $KIND" ;; esac
    mkdir -p "$OUT" || die "cannot create $OUT"
    rm -f "$OUT/.stop"
    for t in gst-launch-1.0 ffmpeg cvlc; do command -v "$t" >/dev/null || die "$t not found"; done
    [ -x "$MRTS_CLI" ] || die "mrts_cli not found (make -C plugins/mpegts-core/native/mrts, or --mrts-cli)"
    LB=""
    command -v stdbuf >/dev/null && LB="stdbuf -oL"
    printf 'CONF_kind=%s CONF_port=%s CONF_duration=%s CONF_raise_at=%s CONF_reepoch_at=%s\nCONF_window=%s CONF_grace=%s CONF_restarts=%s CONF_players=%s\n' \
        "$KIND" "$PORT" "$DUR" "$RAISE_AT" "$REEPOCH_AT" "$WINDOW" "$GRACE" "$RESTARTS" "$PLAYERS" > "$OUT/run.conf"
    echo "$(up) start" > "$OUT/run.log"
    : > "$OUT/events.log"
    trap 'stop_all; $ON_EXIT; exit 130' INT TERM
    # The hooks count from the start line, as the report does.
    hook raise "$RAISE_AT" "$RAISE_CMD" &
    echo $! > "$OUT/hook-raise.pid"
    hook reepoch "$REEPOCH_AT" "$REEPOCH_CMD" &
    echo $! > "$OUT/hook-reepoch.pid"
    i=0 tee_out=""
    set -f
    for pl in $(echo "$PLAYERS" | tr ',' ' '); do
        i=$((i + 1))
        tee_out="$tee_out t. ! queue ! udpsink host=127.0.0.1 port=$((FAN + i)) sync=false async=false"
        cmd=$(player_cmd "$pl" "$i")
        [ -n "$cmd" ] || die "unknown player $pl"
        # shellcheck disable=SC2086
        supervise "$pl" "$OUT/$pl.log" $cmd 2>/dev/null &
    done
    set +f
    sleep 2
    # The front end: a restart (the sender gone and back) opens the next capture segment.
    (
        n=0
        while [ ! -e "$OUT/.stop" ]; do
            n=$((n + 1))
            echo "$(up) front end segment $n" >> "$OUT/run.log"
            eval "exec gst-launch-1.0 -e $(frontend_src) ! queue max-size-buffers=0 max-size-bytes=0 max-size-time=2000000000 ! tee name=t t. ! queue ! filesink location=$OUT/capture-$n.ts sync=false async=false $tee_out" >> "$OUT/frontend.log" 2>&1 &
            fe=$!
            echo $fe > "$OUT/frontend.pid"
            while [ ! -s "$OUT/capture-$n.ts" ] && kill -0 $fe 2>/dev/null; do sleep 0.2; done
            [ -s "$OUT/capture-$n.ts" ] && echo "$(up) data segment $n" >> "$OUT/run.log"
            wait $fe
            [ -e "$OUT/.stop" ] || { echo "$(up) front end exited" >> "$OUT/run.log"; sleep 1; }
        done
    ) 2>/dev/null &
    sleep $((DUR > 2 ? DUR - 2 : 0))
    echo "$(up) end" >> "$OUT/run.log"
    stop_all
    trap - INT TERM
    report_main --out "$OUT" --mrts-cli "$MRTS_CLI"
}

# --- the verdict ---------------------------------------------------------------------------

# A player's judged lines: errors and its supervisor's exits; VLC less the dev Pi's own noise
# (pinned in gst_egress_pins_test.py, case 9).
error_lines() {
    case "$1" in
        ffmpeg) grep -E '\[(error|fatal)\]|EGRESS-COMPAT exit' "$2" ;;
        vlc) grep -E '^[0-9.]+ \[[0-9a-f]+\] .+ error: |EGRESS-COMPAT exit' "$2" \
            | grep -v -e 'main libvlc error: interface "globalhotkeys' \
                -e 'main interface error: no suitable interface module' \
                -e 'avcodec decoder error: cannot start codec (h264_v4l2m2m)' ;;
        gst) grep -E '^[0-9.]+ (ERROR|WARNING): | ERROR +|EGRESS-COMPAT exit' "$2" ;;
    esac
}

# Stdin: stamped lines. Prints `outside N startup N` and `event NAME AT LINES GLITCHES` per event.
# Startup ends GRACE s after the first data; an event's window is AT-1 .. END+W, END moved to the
# first data of a capture segment that starts inside it; a glitch is a run with gaps under 2 s.
judge_lines() {
    awk -v t0="$1" -v grace="$2" -v w="$3" -v evf="$4" -v runf="$5" '
        BEGIN {
            while ((getline l < evf) > 0) {
                split(l, f, " ")
                if (f[3] == "start" || f[3] == "due") {
                    if (!(f[2] in at)) order[++n] = f[2]
                    at[f[2]] = f[1]; endt[f[2]] = f[1]
                } else if (f[3] == "end" && (f[2] in at)) endt[f[2]] = f[1]
            }
            first = ""
            while ((getline l < runf) > 0) {
                split(l, f, " ")
                if (f[2] != "data") continue
                if (first == "") { first = f[1]; continue }
                for (i = 1; i <= n; i++)
                    if (f[1] >= at[order[i]] - 1 && f[1] <= endt[order[i]] + w && f[1] > endt[order[i]])
                        endt[order[i]] = f[1]
            }
            if (first == "") first = t0
        }
        {
            t = $1 + 0
            if (t < first + grace) { startup++; next }
            for (i = 1; i <= n; i++) {
                k = order[i]
                if (t >= at[k] - 1 && t <= endt[k] + w) {
                    lines[k]++
                    if (!(k in last) || t - last[k] >= 2) glitch[k]++
                    last[k] = t
                    next
                }
            }
            outside++
        }
        END {
            printf "outside %d startup %d\n", outside, startup
            for (i = 1; i <= n; i++)
                printf "event %s %.1f %d %d\n", order[i], at[order[i]] - t0, lines[order[i]], glitch[order[i]]
        }'
}

# Stdin: pcrcheck's lines. Prints `seen violations allowed flagged over40 intervals`. Allowed:
# PCR intervals over 40 ms while at most 0.1 % (V-P5-1's 99.9th percentile); per restart R, per
# program R unflagged jumps and R CC errors per ES PID, and R per PSI PID (PAT, each PMT).
judge_pcr() {
    awk -v r="$1" '
        /"pcrcheck":"program"/ {
            j = $0; sub(/.*"pcrJumpsUnflagged":/, "", j); j += 0
            c = $0; sub(/.*"ccErrors":/, "", c); c += 0
            fl = $0; sub(/.*"pcrJumpsFlagged":/, "", fl); flagged += fl
            rp = $0; sub(/.*"pcrRepetitionErrors":/, "", rp); rp += 0
            h = $0; sub(/.*"intervalHistMs":\{/, "", h); sub(/\}.*/, "", h)
            m = split(h, hv, ","); iv = 0
            for (i = 1; i <= m; i++) { sub(/.*:/, "", hv[i]); iv += hv[i] }
            np = gsub(/\{"pid":/, "&")
            allow += (j < r ? j : r) + (c < r * np ? c : r * np) + (rp * 1000 <= iv ? rp : 0)
            over += rp; ivs += iv; escc += c; progs++
        }
        /"pcrcheck":"summary"/ {
            v = $0; sub(/.*"violations":/, "", v); viol += v; seen = 1
            t = $0; sub(/.*"ccErrors":/, "", t); totcc = t + 0
        }
        END {
            # The summary counts every PID; the ones outside the programs ES lists are its violations.
            o = totcc - escc
            if (seen && o > 0) allow += (o < r * (progs + 1) ? o : r * (progs + 1))
            printf "%d %d %d %d %d %d\n", seen, viol, allow, flagged, over, ivs
        }'
}

# The front end's losses of the stream outside the event windows.
frontend_losses() {
    sed -n 's/^\([0-9.]*\) front end exited$/\1 x/p' "$OUT/run.log" \
        | judge_lines "$1" 0 "$2" "$OUT/events.log" /dev/null | awk '/^outside/ { print $2 }'
}

# An event fallen due with no command fails unless `mark` followed it with a start.
due_events() {
    rc=0
    while read -r t k p; do
        [ "$p" = due ] || continue
        if grep -q " $k start$" "$OUT/events.log"; then
            echo "note: $k marked by hand"
        else
            echo "FAIL $k: fell due at $(awk -v a="$t" -v b="$1" 'BEGIN { printf "%.1f", a - b }') s and was never marked"
            rc=1
        fi
    done < "$OUT/events.log"
    return $rc
}

report_body() {
    t0=$1
    fail=0
    echo "egress-compat report: $OUT"
    sed 's/^/    /' "$OUT/run.conf"
    grep -q ' data segment ' "$OUT/run.log" || { echo "FAIL receive: no data arrived"; fail=1; }
    for pl in $(echo "$CONF_players" | tr ',' ' '); do
        [ -e "$OUT/$pl.log" ] || { echo "FAIL $pl: no log"; fail=1; continue; }
        res=$(error_lines "$pl" "$OUT/$pl.log" | judge_lines "$t0" "$CONF_grace" "$CONF_window" "$OUT/events.log" "$OUT/run.log")
        case "$pl" in
            ffmpeg) n=$(sed -n 's/^frame=//p' "$OUT/ffmpeg.progress" 2>/dev/null | tail -n 1)
                proof="frames decoded ${n:-0}"
                [ "${n:-0}" -gt 0 ] || fail=1 ;;
            gst) n=$(grep -o 'from element "[^"]*" (state-changed)[^;]*new-state=(GstState)playing' "$OUT/gst.log" \
                    | sed 's/from element "\([^"]*\)".*/\1/' | grep dec | grep -v decodebin | sort -u | tr '\n' ' ')
                proof="decoders playing: ${n:-none}"
                [ -n "$n" ] || fail=1 ;;
            *) proof="error lines only (no frame count)" ;;
        esac
        o=$(echo "$res" | awk '/^outside/ { print $2 }')
        s=$(echo "$res" | awk '/^outside/ { print $4 }')
        v=PASS
        [ "$o" -eq 0 ] || v=FAIL
        echo "$res" | awk '/^event/ && $5 > 1 { bad = 1 } END { exit !bad }' && v=FAIL
        [ $v = PASS ] || fail=1
        echo "$v $pl: error lines outside the events $o, at startup $s (not judged); $proof"
        echo "$res" | awk '/^event/ { printf "    %s at %s s: %d error lines, %d glitches\n", $2, $3, $4, $5 }'
    done
    x=$(frontend_losses "$t0" "$CONF_window")
    [ "${x:-0}" -eq 0 ] || { echo "FAIL receive: the front end lost the stream $x times outside the events"; fail=1; }
    segs=0
    for c in "$OUT"/capture-*.ts; do
        [ -s "$c" ] || continue
        segs=$((segs + 1))
        "$MRTS_CLI" pcrcheck "$c" > "${c%.ts}.pcrcheck.jsonl" 2>&1
        "$MRTS_CLI" hcdesc "$c" > "${c%.ts}.hcdesc.jsonl" 2>&1
        set -- $(judge_pcr "$CONF_restarts" < "${c%.ts}.pcrcheck.jsonl")
        v=PASS
        if [ "$1" -ne 1 ] || [ $(($2 - $3)) -gt 0 ]; then v=FAIL; fail=1; fi
        echo "$v pcrcheck $(basename "$c"): violations $2, allowed $3; flagged PCR jumps $4; PCR intervals over 40 ms $5 of $6"
        sed -n 's/.*"version":\([0-9]*\),"mrht":.*"epochSeq":\([0-9]*\),.*"dENs":\([0-9]*\),.*/    PMT v\1: MRHT epoch \2, D_e \3 ns/p; s/.*"version":\([0-9]*\),"mrht":null.*/    PMT v\1: no MRHT/p' "${c%.ts}.hcdesc.jsonl"
    done
    [ $segs -gt 0 ] || { echo "FAIL pcrcheck: nothing captured"; fail=1; }
    due_events "$t0" || fail=1
    [ $fail -eq 0 ] && echo "RESULT PASS" || echo "RESULT FAIL"
}

report_main() {
    while [ $# -gt 0 ]; do
        [ $# -ge 2 ] || die "$1 needs a value"
        case "$1" in --out) OUT=$2 ;; --mrts-cli) MRTS_CLI=$2 ;; *) die "unknown option $1" ;; esac
        shift 2
    done
    [ -n "$OUT" ] && [ -f "$OUT/run.log" ] || die "--out: not a run directory"
    [ -n "$MRTS_CLI" ] || MRTS_CLI=$ROOT/plugins/mpegts-core/native/mrts/mrts_cli
    t0=$(awk '$2 == "start" { print $1; exit }' "$OUT/run.log")
    . "$OUT/run.conf"
    report_body "$t0" > "$OUT/report.txt"
    cat "$OUT/report.txt"
    grep -q '^RESULT PASS' "$OUT/report.txt"
}

mark_main() {
    [ "${1:-}" = --out ] && [ $# -eq 3 ] || die "mark --out DIR NAME"
    OUT=$2
    [ -f "$OUT/events.log" ] || die "$OUT is not a run"
    ev "$3" start
}

# --- the dry run: a sender on the dev Pi as a box's ---------------------------------------

# The engine's house-clock value (houseClockFieldsString): E = TAI - CLOCK_MONOTONIC.
house_clock() {
    echo "house-clock, e-ns=(gint64)$2, seq=(uint)$1, traceable=(boolean)true, disciplined=(boolean)true, source=(string)ntp, error-us=(uint)1000, tai-offset-s=(int)37, ptp-domain=(int)-1"
}
json_str() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

# A runner started with base time 0, as the engine runs it; its FIFO held open by a holder.
runner() {
    name=$1 pipe=$2
    rm -f "$D/$name.fifo"
    mkfifo "$D/$name.fifo"
    "$RUNNER" < "$D/$name.fifo" > "$D/$name.out" 2> "$D/$name.err" &
    echo $! > "$D/$name.rpid"
    ( exec 8> "$D/$name.fifo"
      printf '{"cmd":"start","pipeline":"%s"}\n' "$(json_str "$pipe")" >&8
      exec sleep $((DUR + 60)) ) &
    echo $! > "$D/$name.hpid"
}

dry_reepoch() {
    D=$1
    read -r seq e < "$D/sender.epoch"
    seq=$((seq + 1)) e=$((e + 2000000000))
    echo "$seq $e" > "$D/sender.epoch"
    printf '{"cmd":"set_property","id":"reepoch-%s","element":"egress","property":"house-clock","value":"%s"}\n' \
        "$seq" "$(json_str "$(house_clock "$seq" "$e")")" > "$D/sender.fifo"
    echo "re-epoch: seq $seq, E +2 s"
}

dry_main() {
    PORT=15010 DUR=120 RAISE_AT=40 REEPOCH_AT=80
    parse "$@"
    case "$KIND" in *-listener) HOST=127.0.0.1 ;; *) HOST="" ;; esac
    RUNNER=${MR_GST_RUNNER:-$ROOT/packages/engine/native/mr-gst-runner/mr-gst-runner}
    [ -x "$RUNNER" ] || die "mr-gst-runner not built ($RUNNER)"
    export MR_PLUGINS_DIR=$ROOT/plugins
    export GST_PLUGIN_PATH=$ROOT/plugins/mpegts-core/native/mrtshouse:$ROOT/plugins/rist-core/native/mrrist${GST_PLUGIN_PATH:+:$GST_PLUGIN_PATH}
    mkdir -p "$OUT/sender" || die "cannot create $OUT"
    # Never the user's registry: a private one beside the run unless one is given.
    export GST_REGISTRY=${GST_REGISTRY:-$OUT/sender/registry.bin}
    D=$OUT/sender
    up_port=$((FAN + 90))
    runner upstream "videotestsrc is-live=true pattern=ball ! video/x-raw,width=640,height=360,framerate=25/1 ! x264enc tune=zerolatency speed-preset=ultrafast bitrate=1500 key-int-max=50 ! h264parse ! mux. audiotestsrc is-live=true wave=ticks ! audioconvert ! avenc_mp2 bitrate=128000 ! mux. mpegtsmux name=mux alignment=7 ! udpsink host=127.0.0.1 port=$up_port sync=false"
    u=$(up)
    e=$(( $(date +%s%N) - ${u%.*} * 1000000000 - (1${u#*.} - 100) * 10000000 + 37000000000 ))
    echo "1 $e" > "$D/sender.epoch"
    s=${EGRESS_COMPAT_SECRET:-}
    case "$KIND" in
        srt-caller) sink="srtsink uri=\"srt://127.0.0.1:$PORT?mode=caller&latency=$LAT\" sync=false wait-for-connection=false${s:+ passphrase=\"$s\"}" ;;
        srt-listener) sink="srtsink uri=\"srt://:$PORT?mode=listener&latency=$LAT\" sync=false wait-for-connection=false${s:+ passphrase=\"$s\"}" ;;
        udp) sink="udpsink host=127.0.0.1 port=$PORT sync=false" ;;
        rtp) sink="rtpmp2tpay ! udpsink host=127.0.0.1 port=$PORT sync=false" ;;
        rist) sink="mrristsink urls=\"rist://127.0.0.1:$PORT\" profile=$PROFILE buffer=$BUF${s:+ secret=\"$s\"}" ;;
        rist-listener) sink="mrristsink urls=\"rist://@127.0.0.1:$PORT\" profile=$PROFILE buffer=$BUF${s:+ secret=\"$s\"}" ;;
    esac
    # The sender as srt-output's and mpegts-ip-output's: a queue, the writer, the re-slice.
    ( sleep 4
      runner sender "udpsrc port=$up_port buffer-size=4194304 caps=\"video/mpegts,systemstream=(boolean)true,packetsize=(int)188\" ! queue max-size-time=0 max-size-buffers=0 max-size-bytes=8388608 ! mrtsegress name=egress house-clock=\"$(house_clock 1 "$e")\" ! tsparse alignment=7 set-timestamps=false ! $sink"
      wait ) 2>/dev/null &
    RAISE_CMD="$SELF stall -p $(cat "$D/upstream.rpid") -s 1.5"
    REEPOCH_CMD="$SELF _reepoch $D"
    ON_EXIT=dry_cleanup
    rc=0
    run_body || rc=$?
    dry_cleanup
    return $rc
}

# The runners, their FIFO holders and the FIFOs (a grep over the directory would block on one).
dry_cleanup() {
    for f in "$D"/*.hpid "$D"/*.rpid; do [ -e "$f" ] && kill "$(cat "$f")" 2>/dev/null; done
    rm -f "$D"/*.fifo "$D"/*.hpid "$D"/*.rpid
}

# --- the judging over synthetic logs -------------------------------------------------------

selftest() {
    OUT=$(mktemp -d)
    trap 'rm -rf "$OUT"' EXIT
    fails=0
    t() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1: got '$2', want '$3'"; fails=$((fails + 1)); fi; }
    j() { error_lines "$1" "$OUT/$1.log" | judge_lines 100 10 10 "$OUT/events.log" "$OUT/run.log" | tr '\n' ';'; }
    printf '100.0 start\n103.0 data segment 1\n' > "$OUT/run.log"
    printf '160.0 raise start\n161.5 raise end\n220.0 reepoch start\n230.0 reepoch end\n' > "$OUT/events.log"
    printf '%s\n' '112.5 [h264 @ 0x1] [error] non-existing PPS 0 referenced' \
        '161.0 [h264 @ 0x1] [error] a' '162.5 [h264 @ 0x1] [error] b' '163.0 [h264 @ 0x1] [warning] c' \
        '236.0 [mpegts @ 0x1] [error] d' > "$OUT/ffmpeg.log"
    t "startup from the first data, one glitch per event" "$(j ffmpeg)" "outside 0 startup 1;event raise 60.0 2 1;event reepoch 120.0 1 1;"
    printf '%s\n' '250.0 [h264 @ 0x1] [error] e' '165.0 [h264 @ 0x1] [error] f' >> "$OUT/ffmpeg.log"
    t "outside the windows, two glitches" "$(j ffmpeg)" "outside 1 startup 1;event raise 60.0 3 2;event reepoch 120.0 1 1;"
    echo '240.0 data segment 2' >> "$OUT/run.log"
    t "a segment starting in a window moves its end" "$(j ffmpeg)" "outside 0 startup 1;event raise 60.0 3 2;event reepoch 120.0 2 2;"
    printf '%s\n' '300.0 [0000aaaa] main interface error: no suitable interface module' \
        '301.0 [0000aaaa] main libvlc error: interface "globalhotkeys,none" initialization failed' \
        '170.5 [0000aaaa] main input error: ES_OUT_SET_(GROUP_)PCR  is called too late' \
        '302.0 EGRESS-COMPAT exit: vlc ended before the run did' > "$OUT/vlc.log"
    t "VLC noise dropped, an exit judged" "$(j vlc)" "outside 1 startup 0;event raise 60.0 1 1;event reepoch 120.0 0 0;"
    printf '%s\n' '230.5 WARNING: from element /GstPipeline:pipeline0/avdec_h264:avdec_h264-0: Could not decode stream.' \
        '231.0 Got message #40 from element "sink-a" (stream-start): GstMessageStreamStart' \
        '400.0 0:05:00.1 123 0xaaaa ERROR   libav :0:: corrupt input' > "$OUT/gst.log"
    t "gst warnings and debug errors" "$(j gst)" "outside 1 startup 0;event raise 60.0 0 0;event reepoch 120.0 1 1;"
    p='{"pcrcheck":"program","program":1,"pcrs":1001,"intervalHistMs":{"10":500,"40":499,"100":1},"pcrRepetitionErrors":1,"pcrJumpsUnflagged":1,"pcrJumpsFlagged":2,"ccErrors":2,"pids":[{"pid":256,"timing":true},{"pid":257,"timing":true}],"violations":4}'
    sm='{"pcrcheck":"summary","packets":9,"ccErrors":2,"violations":4}'
    t "pcrcheck, no restart allowed" "$(printf '%s\n%s\n' "$p" "$sm" | judge_pcr 0)" "1 4 1 2 1 1000"
    t "pcrcheck, one restart allowed" "$(printf '%s\n%s\n' "$p" "$sm" | judge_pcr 1)" "1 4 4 2 1 1000"
    p2=$(echo "$p" | sed 's/"40":499/"40":498/')
    t "pcrcheck, over 0.1 % of intervals over 40 ms" "$(printf '%s\n%s\n' "$p2" "$sm" | judge_pcr 0)" "1 4 0 2 1 999"
    t "pcrcheck, no summary" "$(printf '%s\n' "$p" | judge_pcr 1)" "0 0 4 2 1 1000"
    # A restart's CC errors on PAT and PMT: the summary's count over the programs'.
    sp='{"pcrcheck":"summary","packets":9,"ccErrors":5,"violations":7}'
    t "pcrcheck, a restart's PSI CC errors allowed" "$(printf '%s\n%s\n' "$p" "$sp" | judge_pcr 1)" "1 7 6 2 1 1000"
    t "pcrcheck, PSI CC errors past one per PSI PID" "$(printf '%s\n%s\n' "$p" "$(echo "$sp" | sed 's/"ccErrors":5/"ccErrors":6/')" | judge_pcr 1)" "1 7 6 2 1 1000"
    t "pcrcheck, PSI CC errors with no restart" "$(printf '%s\n%s\n' "$p" "$sp" | judge_pcr 0)" "1 7 1 2 1 1000"
    # The window opens 1 s before the hook.
    printf '%s\n' '159.5 [h264 @ 0x1] [error] g' > "$OUT/ffmpeg.log"
    t "a line just before the hook is the event's" "$(j ffmpeg)" "outside 0 startup 0;event raise 60.0 1 1;event reepoch 120.0 0 0;"
    printf '%s\n' '158.5 [h264 @ 0x1] [error] g' > "$OUT/ffmpeg.log"
    t "a line before the window is outside" "$(j ffmpeg)" "outside 1 startup 0;event raise 60.0 0 0;event reepoch 120.0 0 0;"
    printf '100.0 start\n103.0 data segment 1\n165.0 front end exited\n190.0 front end exited\n' > "$OUT/run.log"
    t "the front end lost the stream once outside the events" "$(frontend_losses 100 10)" "1"
    printf '100.0 raise due\n' > "$OUT/events.log"
    t "an event left due fails" "$(due_events 100 >/dev/null; echo $?)" "1"
    printf '100.0 raise due\n104.0 raise start\n' > "$OUT/events.log"
    t "an event marked by hand passes" "$(due_events 100; echo $?)" "note: raise marked by hand
0"
    [ $fails -eq 0 ] && echo "selftest: all passed" || echo "selftest: $fails failed"
    [ $fails -eq 0 ]
}

cmd=${1:-}
[ $# -gt 0 ] && shift
case "$cmd" in
    run) parse "$@"; run_body ;;
    dry-run) dry_main "$@" ;;
    mark) mark_main "$@" ;;
    report) report_main "$@" ;;
    selftest) selftest ;;
    runners) box_runners ;;
    stall) box_stall "$@" ;;
    _reepoch) dry_reepoch "$1" ;;
    ""|-h|--help) usage ;;
    *) die "unknown command $cmd (--help)" ;;
esac
