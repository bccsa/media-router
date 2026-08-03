#!/usr/bin/env python3
"""Self-checking tests for render_lag.py (no GStreamer, no engine).

Run:  python3 render_lag_test.py
"""
import sys

from render_lag import RenderLagMonitor

_failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        _failures.append(name)


def ticks(mon, seq, expected=50.0, window=2.0):
    """Feed per-window frame counts; return list of non-None events."""
    out = []
    for frames in seq:
        ev = mon.tick(frames, window, expected)
        if ev:
            out.append(ev)
    return out


# --- trips only after 3 consecutive lagging windows -------------------------
m = RenderLagMonitor()
# 50 fps expected over 2 s windows → 100 frames = keeping up, 50 = half rate.
evs = ticks(m, [100, 50, 50])
check("no event before third lagging window", evs == [])
evs = ticks(m, [50])
check("lag trips on third consecutive window", len(evs) == 1 and evs[0][0] == "lag")
check("lag payload carries achieved fps", abs(evs[0][1] - 25.0) < 0.01)
check("lag payload carries expected fps", evs[0][2] == 50.0)
check("monitor latched lagging", m.lagging)

# --- a good window mid-streak resets the trip counter -----------------------
m = RenderLagMonitor()
evs = ticks(m, [50, 50, 100, 50, 50])
check("interrupted streak does not trip", evs == [] and not m.lagging)

# --- recovery needs 3 consecutive good windows, then emits once -------------
m = RenderLagMonitor()
ticks(m, [50, 50, 50])          # trip
evs = ticks(m, [100, 100])
check("no recovery before third good window", evs == [])
evs = ticks(m, [100])
check("recovered emits on third good window", len(evs) == 1 and evs[0][0] == "recovered")
check("monitor unlatched", not m.lagging)
evs = ticks(m, [100, 100, 100])
check("no duplicate recovered events", evs == [])

# --- hysteresis band (between 0.85 and 0.95) advances neither streak --------
m = RenderLagMonitor()
ticks(m, [50, 50])              # two lagging windows
evs = ticks(m, [90])            # 45 fps = 0.90 × expected → in the band
check("band window emits nothing", evs == [])
evs = ticks(m, [50, 50, 50])    # streak restarted from zero
check("band window reset the lag streak", len(evs) == 1 and evs[0][0] == "lag")

# --- zero-frame windows BEFORE first frame are startup, not lag -------------
m = RenderLagMonitor()
evs = ticks(m, [0, 0, 0, 0])
check("preroll windows never trip lag", evs == [] and not m.lagging)

# --- zero-frame windows AFTER frames flowed are the worst lag ---------------
# A starving sink behind a flowing source: decoder sheds so much upstream
# that whole windows come up empty. Alternating 0/1-frame windows must
# accumulate, not reset (the .211 grey-smear case that evaded detection).
m = RenderLagMonitor()
ticks(m, [100])                 # started, keeping up
evs = ticks(m, [0, 1, 0])
check("post-start starvation trips lag", len(evs) == 1 and evs[0][0] == "lag")
check("lag payload reports near-zero achieved", evs[0][1] < 1.0)

# --- unknown expected fps disables judgement --------------------------------
m = RenderLagMonitor()
evs = ticks(m, [50, 50, 50], expected=0)
check("no events without a declared framerate", evs == [] and not m.lagging)

# --- expected-fps change (format switch) resets streaks ---------------------
m = RenderLagMonitor()
ticks(m, [50, 50], expected=50.0)
evs = ticks(m, [50], expected=25.0)   # 25 fps achieved vs 25 expected = fine
check("format switch does not trip on stale streak", evs == [] and not m.lagging)

# --- caps switch mid-lag does not synthesize recovery -----------------------
m = RenderLagMonitor()
ticks(m, [50, 50, 50], expected=50.0)   # lagging
m.reset()
check("reset keeps the lag latch", m.lagging)
evs = ticks(m, [100, 100, 100], expected=50.0)
check("recovery after reset is measured, not assumed",
      len(evs) == 1 and evs[0][0] == "recovered")

# --- sustained sink drops trip lag even above the presented-fps ratio -------
# Field case 2026-08-02: presented 44/50 fps (ratio 0.88, inside the
# hysteresis band) with 5 fps steadily dropped as late — stuttered for
# minutes with no event.
m = RenderLagMonitor()
ticks(m, [100])                                      # healthy start
evs = []
for _ in range(3):
    ev = m.tick(88, 2.0, 50.0, dropped_fps=5.0)
    if ev:
        evs.append(ev)
check("sustained drops trip lag", len(evs) == 1 and evs[0][0] == "lag")

# --- recovery requires drops to clear, not just presented fps ---------------
evs = []
for _ in range(4):
    ev = m.tick(100, 2.0, 50.0, dropped_fps=5.0)     # presents fine, still drops
    if ev:
        evs.append(ev)
check("no recovery while still dropping", evs == [] and m.lagging)
evs = []
for _ in range(3):
    ev = m.tick(100, 2.0, 50.0, dropped_fps=0.0)
    if ev:
        evs.append(ev)
check("recovery once drops clear", len(evs) == 1 and evs[0][0] == "recovered")

# --- transient drop blips do not trip ---------------------------------------
m = RenderLagMonitor()
ticks(m, [100])
m.tick(95, 2.0, 50.0, dropped_fps=4.0)
m.tick(100, 2.0, 50.0, dropped_fps=0.0)              # blip over — streak resets
m.tick(95, 2.0, 50.0, dropped_fps=4.0)
m.tick(95, 2.0, 50.0, dropped_fps=4.0)
check("transient drop blips stay silent", not m.lagging)

print()
if _failures:
    print(f"{len(_failures)} FAILED")
    sys.exit(1)
print("all render_lag tests passed")
