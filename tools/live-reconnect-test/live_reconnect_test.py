#!/usr/bin/env python3
"""Live reconnect test — runs ON a media-router box (default: the .103 test rig).

Drives a real producer→consumer pair through the three ways a bus goes dark and
checks that the consumer waits and comes back on its own, without restart loops
(ADR-0010 rule 3, gst-pipeline-runner.py `_data_wait`):

  A0. feed stops under a running consumer — it idles, nothing restarts
  A1. consumer STARTS while the bus is dark (feed stopped, consumer module
      re-enabled) — the case that restart-looped every 10 s before ADR-0010
      rule 3; it must park, warn once, and play when the feed returns
  B. source down   — the producer MODULE is disabled, then enabled
  C. dest down     — the consumer MODULE is disabled, then enabled

Default pair on .103: mpegts-ip-input-ttxtest01 (udp 127.0.0.1:5510 from the
`ttx-gen.service` user unit) → teletext-subtitles-ttxtest01, a plain non-live
unixfdsrc consumer. NOT the video-player: it carries its own 5 s bus watchdog
and switches to a fallback picture by design, so it never restart-looped and
its health stays ok while dark (checked 2026-09-15).

Evidence is the engine journal (`journalctl _UID=1001`) plus the module's
runtime state from the local manager (mr_ctl.js → Socket.IO `engine:state`).

Usage (on the box, as mrstation):
  python3 live_reconnect_test.py [--src ID] [--dst ID] [--gen UNIT] [--engine ID] [--quick]
Exit 0 = all checks passed.
"""
import argparse
import glob
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ENV = dict(os.environ, XDG_RUNTIME_DIR="/run/user/1001")
FAILS = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))
    if not cond:
        FAILS.append(name)


def sh(cmd, timeout=30):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout, env=ENV).stdout


def journal_since(t0):
    return sh(f'journalctl _UID=1001 --no-pager -o short-iso --since "@{int(t0)}" 2>/dev/null', timeout=60)


def state(engine, module):
    out = sh(f'node {HERE}/mr_ctl.js state {engine} {module}', timeout=20).strip()
    try:
        return json.loads(out.splitlines()[-1])
    except Exception:  # noqa: BLE001
        return {}


def enable(engine, module, on):
    sh(f'node {HERE}/mr_ctl.js enable {engine} {module} {"true" if on else "false"}', timeout=20)


def fnv6(s):
    h = 0x811C9DC5
    for ch in s:
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return format(h, "08x")[-6:]


def edge_socket(src, dst):
    """The consumer edge socket for src:mpegts-out → dst:mpegts-in (busHelpers.ts)."""
    h = fnv6(f"{src}:mpegts-out-{dst}:mpegts-in")
    hits = glob.glob(f"/tmp/mr-bus-*-{h}.sock")
    return (hits[0] if hits else None), h


def wait_for(pred, seconds, step=1.0):
    end = time.time() + seconds
    while time.time() < end:
        if pred():
            return True
        time.sleep(step)
    return pred()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", default="local")
    ap.add_argument("--src", default="mpegts-ip-input-ttxtest01")
    ap.add_argument("--dst", default="teletext-subtitles-ttxtest01")
    ap.add_argument("--gen", default="ttx-gen.service", help="user unit that feeds --src")
    ap.add_argument("--quick", action="store_true", help="shorter dark windows (dev only)")
    a = ap.parse_args()
    dark_s = 25 if a.quick else 45          # > the 10 s watchdog, > 2 old restart cycles

    sock, h = edge_socket(a.src, a.dst)
    print(f"pair: {a.src} -> {a.dst}   edge hash {h}   socket {sock}")
    st0 = state(a.engine, a.dst)
    print(f"consumer state at start: {st0}")
    check("precondition: consumer running and healthy", st0.get("running") is True and st0.get("health") == "ok",
          json.dumps(st0))
    check("precondition: edge socket exists", sock is not None)
    sockpat = os.path.basename(sock) if sock else f"-{h}.sock"

    # ---------------- A0. running consumer, feed stops: it idles, nothing restarts
    print("\n=== A0. feed stops under a RUNNING consumer (idles, no restart) ===")
    t0 = time.time()
    sh(f"systemctl --user stop {a.gen}")
    time.sleep(15)
    j = journal_since(t0)
    check("A0: no PLAYING-timeout restarts", j.count("did not reach PLAYING") == 0)
    check("A0: the consumer pipeline was not rebuilt", not any("Starting pipeline" in l and sockpat in l for l in j.splitlines()))
    check("A0: consumer still running", state(a.engine, a.dst).get("running") is True)

    # ---------------- A1. consumer STARTS on the dark bus — the case that used to loop every 10 s
    print("\n=== A1. consumer restarted while the bus is dark (the old restart loop) ===")
    enable(a.engine, a.dst, False)
    wait_for(lambda: state(a.engine, a.dst).get("running") is False, 15)
    t1 = time.time()
    enable(a.engine, a.dst, True)
    time.sleep(dark_s)
    sock, _ = edge_socket(a.src, a.dst)
    sockpat = os.path.basename(sock) if sock else sockpat
    j = journal_since(t1)
    loops = j.count("did not reach PLAYING")
    waits = [l for l in j.splitlines() if "no data yet on bus socket" in l and sockpat in l]
    starts = [l for l in j.splitlines() if "Starting pipeline" in l and sockpat in l]
    stA = state(a.engine, a.dst)
    # The producer itself may restart while its own feed is dark (mpegts-ip-input
    # restarts on udpsrc's 5 s silence timeout): each of those re-creates the edge
    # socket and the parked consumer must follow it (bus_producer_restarted), so
    # consumer rebuilds are bounded by producer restarts — never by a 10 s timer.
    prod_starts = j.count("Starting pipeline (bus-messages): udpsrc") if "udpsrc" in j else 0
    reconnects = [l for l in j.splitlines() if "bus_producer_restarted" in l or "was re-created while waiting" in l]
    check(f"A1: no PLAYING-timeout restarts in {dark_s} s on a dark bus (was one every 10 s)", loops == 0, f"{loops}")
    check("A1: the consumer reported waiting_for_data exactly once, naming its socket",
          len(waits) == 1, f"waits={len(waits)} starts={len(starts)}")
    check("A1: the consumer pipeline was built once and never rebuilt while dark",
          len(starts) == 1 and len(reconnects) == 0, f"starts={len(starts)} reconnects={len(reconnects)}")
    check("A1: the silent UDP producer did NOT restart itself (udp silence is a state now)",
          prod_starts == 0, f"producer_starts={prod_starts}")
    # The producer went silent when the generator stopped in A0, so its single
    # input_silent sits in the A0 window: count it from the generator stop.
    check("A1: the producer reports input_silent exactly once for the whole dark period",
          journal_since(t0).count("silent — waiting for data, not restarting") == 1)
    check("A1: module health is a WARNING naming the upstream module (not an error)",
          stA.get("health") == "warning" and a.src in str(stA.get("error", "")), json.dumps(stA))
    check("A1: the consumer module is running (parked, not stopped)", stA.get("running") is True)

    t2 = time.time()
    sh(f"systemctl --user start {a.gen}")
    ok = wait_for(lambda: state(a.engine, a.dst).get("health") == "ok", 40)
    j = journal_since(t2)
    check("A1: after the feed returns, data_arrived is logged (no fresh attach needed)", "bus data arrived" in j)
    check("A1: the producer reports input_resumed", "receiving again" in j)
    check("A1: module health back to ok within 40 s of the feed returning", ok, json.dumps(state(a.engine, a.dst)))
    check("A1: no PLAYING-timeout restart during recovery", j.count("did not reach PLAYING") == 0)

    # ---------------- B. source module disabled / enabled (the engine removes and re-applies the connection)
    print("\n=== B. source module disabled, then enabled ===")
    t3 = time.time()
    enable(a.engine, a.src, False)
    okB = wait_for(lambda: state(a.engine, a.src).get("running") is False, 15)
    check("B: producer module stops when disabled", okB)
    time.sleep(12)
    stB = state(a.engine, a.dst)
    check("B: consumer neither errors nor restarts while its producer is down",
          stB.get("health") in ("ok", "warning") and journal_since(t3).count("did not reach PLAYING") == 0, json.dumps(stB))
    t4 = time.time()
    enable(a.engine, a.src, True)
    okB2 = wait_for(lambda: state(a.engine, a.dst).get("health") == "ok" and state(a.engine, a.dst).get("running") is True, 30)
    check("B: consumer healthy again within 30 s of the producer coming back", okB2, json.dumps(state(a.engine, a.dst)))
    check("B: no PLAYING-timeout restart during the reconnect", journal_since(t4).count("did not reach PLAYING") == 0)
    sock, _ = edge_socket(a.src, a.dst)
    check("B: the edge socket exists again", sock is not None)

    # ---------------- C. consumer module disabled / enabled
    print("\n=== C. consumer module disabled, then enabled ===")
    t5 = time.time()
    enable(a.engine, a.dst, False)
    okC = wait_for(lambda: state(a.engine, a.dst).get("running") is False, 15)
    check("C: consumer stops when disabled", okC)
    time.sleep(3)
    enable(a.engine, a.dst, True)
    okC2 = wait_for(lambda: state(a.engine, a.dst).get("running") is True and state(a.engine, a.dst).get("health") == "ok", 30)
    check("C: consumer running and healthy within 30 s of re-enable", okC2, json.dumps(state(a.engine, a.dst)))
    check("C: no PLAYING-timeout restart on the way back", journal_since(t5).count("did not reach PLAYING") == 0)

    print()
    if FAILS:
        print(f"{len(FAILS)} FAILED:")
        for f in FAILS:
            print("  - " + f)
        sys.exit(1)
    print("All live reconnect checks passed.")


if __name__ == "__main__":
    main()
