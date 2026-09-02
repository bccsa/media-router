#!/bin/sh
# Per-thread CPU profile of every GStreamer pipeline runner on a media-router
# box. BusyBox-only (no procps, no strace, no perf): samples /proc over a
# window and prints, per runner, the module that owns it, its total CPU, and
# the busiest threads with their wakeup rate. This is the acceptance metric
# for the muxer/bus CPU work (docs/research/mpegts-muxer-cpu-baseline.md):
# run it before and after a change on the same wiring and compare ticks.
#
# Usage (on the box):
#   sh runner-cpu-profile.sh [-t SECONDS] [-n TOP_THREADS] [-m MODULE_SUBSTR]
# From a dev machine:
#   mrscp tools/runner-cpu-profile.sh <ip>:/tmp/ && \
#   mrssh <ip> 'sh /tmp/runner-cpu-profile.sh -t 10'
#
# Reading the output:
#   ticks   CPU ticks (1/100 s) consumed over the window. 100 ticks/s = one
#           full core, so "340 ticks / 5 s" = 0.68 of a core.
#   wk/s    context switches per second = how often the thread woke. A bus
#           edge at 1316-byte granularity shows ~1 wakeup per TS chunk.
#   Thread names are GStreamer's: `<element>:src` is that element's streaming
#   thread (everything downstream of it up to the next queue runs there),
#   `python3` is the runner's GLib main loop, `watchdog` / `unixfdsink` are
#   element-owned helper threads.
# Module ownership comes from /tmp/engine.log ("Allocated port" lines) via the
# bus socket the runner listens on; a runner with no listening socket (pure
# consumer, e.g. srt-output) is labelled by its thread names instead.

WINDOW=5
TOPN=8
MATCH=""
while [ $# -gt 0 ]; do
    case "$1" in
        -t) WINDOW="$2"; shift 2 ;;
        -n) TOPN="$2"; shift 2 ;;
        -m) MATCH="$2"; shift 2 ;;
        -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
        *) echo "unknown arg: $1" >&2; exit 2 ;;
    esac
done

LOG=/tmp/engine.log
TMP=/tmp/runner-cpu-profile.$$
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT INT TERM

# --- helpers ---------------------------------------------------------------

# ticks of a task: utime + stime from /proc/<pid>/task/<tid>/stat
task_ticks() { awk '{print $14+$15}' "$1/stat" 2>/dev/null; }
# total context switches of a task
task_ctxt() { awk '/ctxt_switches/{s+=$2} END{print s+0}' "$1/status" 2>/dev/null; }

# Bus port a runner LISTENS on (its busout tee edge socket), from the
# mr-bus-<port>-<hash>.sock path behind its socket fds.
runner_port() {
    pid=$1
    for fd in /proc/$pid/fd/*; do
        ino=$(readlink "$fd" 2>/dev/null | sed -n 's/^socket:\[\([0-9]*\)\]$/\1/p')
        [ -n "$ino" ] || continue
        path=$(awk -v i="$ino" '$7==i {print $8}' /proc/net/unix 2>/dev/null)
        case "$path" in
            /tmp/mr-bus-*) echo "$path" | sed -n 's|.*/mr-bus-\([0-9]*\)-.*|\1|p'; return ;;
        esac
    done
}

# ownerId for a bus port from the engine log (last allocation wins).
port_owner() {
    [ -n "$1" ] && [ -r "$LOG" ] || return
    grep -E "\"port\":$1,\"msg\":\"(Allocated port|Re-allocated previous port)\"" "$LOG" 2>/dev/null \
        | tail -n 1 | sed -n 's/.*"ownerId":"\([^"]*\)".*/\1/p'
}

# Fallback label from thread names when there is no listening socket.
thread_label() {
    names=$(for t in /proc/$1/task/*; do cat "$t/comm" 2>/dev/null; done | tr '\n' ' ')
    case "$names" in
        *busin_*) echo "consumer(tsdemux inputs)" ;;
        *SRT:*) echo "consumer(srt)" ;;
        *rist*) echo "consumer(rist)" ;;
        *unixfdsrc*) echo "consumer(bus)" ;;
        *) echo "runner" ;;
    esac
}

snapshot() {
    out=$1
    : > "$out"
    for pid in $(pgrep -f gst-pipeline-runner.py); do
        for t in /proc/$pid/task/*; do
            [ -r "$t/stat" ] || continue
            echo "$pid $(basename "$t") $(tr ' ' '_' < "$t/comm") $(task_ticks "$t") $(task_ctxt "$t")" >> "$out"
        done
    done
}

cpu_line() { head -n 1 /proc/stat; }

# --- sample ------------------------------------------------------------------

RUNNERS=$(pgrep -f gst-pipeline-runner.py | tr '\n' ' ')
if [ -z "$RUNNERS" ]; then echo "no gst-pipeline-runner.py processes"; exit 1; fi

# Resolve labels once (cheap, and the pid set is fixed for the window).
: > "$TMP/labels"
for pid in $RUNNERS; do
    port=$(runner_port "$pid")
    owner=$(port_owner "$port")
    if [ -n "$owner" ]; then label="$owner"
    else label=$(thread_label "$pid"); fi
    echo "$pid ${port:--} $label" >> "$TMP/labels"
done

C1=$(cpu_line); snapshot "$TMP/s1"
sleep "$WINDOW"
C2=$(cpu_line); snapshot "$TMP/s2"

# --- report ------------------------------------------------------------------

echo "runner-cpu-profile  host=$(hostname)  $(date -u +%Y-%m-%dT%H:%M:%SZ)  window=${WINDOW}s  cores=$(nproc)"
echo "load: $(cut -d' ' -f1-3 /proc/loadavg)"
echo "$C1" "$C2" | awk '{
    # fields: cpu user nice system idle iowait irq softirq steal (x2)
    u=$13-$2; n=$14-$3; s=$15-$4; i=$16-$5; w=$17-$6; q=$18-$7; sq=$19-$8;
    tot=u+n+s+i+w+q+sq; if (tot<=0) tot=1;
    printf "box: usr %.0f%%  sys %.0f%%  irq %.0f%%  idle %.0f%%  (of all cores)\n",
        100*(u+n)/tot, 100*s/tot, 100*(q+sq)/tot, 100*i/tot }'
echo

# join s1/s2 by pid_tid; emit per-thread delta lines
awk -v W="$WINDOW" 'NR==FNR { t[$1"_"$2]=$4; c[$1"_"$2]=$5; next }
    { k=$1"_"$2; dt=$4-t[k]; dc=$5-c[k]; if (dt=="") next;
      printf "%s %s %s %d %.0f\n", $1, $2, $3, dt, dc/W }' "$TMP/s1" "$TMP/s2" > "$TMP/delta"

# per-runner totals, sorted busiest first
awk '{ tot[$1]+=$4 } END { for (p in tot) print tot[p], p }' "$TMP/delta" | sort -rn > "$TMP/order"

while read -r total pid; do
    set -- $(grep "^$pid " "$TMP/labels")
    port=$2; label=$3
    if [ -n "$MATCH" ]; then
        case "$label" in *"$MATCH"*) ;; *) continue ;; esac
    fi
    rss=$(awk '/VmRSS/{print $2}' /proc/$pid/status 2>/dev/null)
    printf '%s  pid=%s  bus-port=%s  total=%d ticks/%ss (%.2f core)  rss=%sMB\n' \
        "$label" "$pid" "$port" "$total" "$WINDOW" "$(awk -v t="$total" -v w="$WINDOW" 'BEGIN{printf "%.2f", t/(w*100)}')" "$((${rss:-0}/1024))"
    grep "^$pid " "$TMP/delta" | sort -k4 -rn | head -n "$TOPN" \
        | awk '{ printf "    %-22s %4d ticks  %6s wk/s\n", $3, $4, $5 }'
    echo
done < "$TMP/order"
