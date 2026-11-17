#!/usr/bin/env python3
"""The Python reference of mrasrc's catch-up (plan ch. 15.4 B-249, the owner's "2 yes" of 2026-11-17): an audio
output whose sink runs sync=false (B-217) never drops late audio, so once it is late it stays that late: after a
lateness spike, and after a late start (pulsesink's clock starting 0.3-2 s after the first push, the backlog kept
in the queue before the sink). The catch-up plays what is held beyond the margin out slightly fast, by resampling,
never by dropping: the ratio runs at most RATE_PPM (0.5 %, the owner's drain rate of 2026-11-09; 8.6 cents of
pitch) fast until the output is back at its margin. Ported into mrts::AsrcCatchUp (asrc_servo.h) for mrasrc's
device mode, held to it by catch_up_parity_test.py. A reference only: nothing loads it at runtime (ADR-0029
choice 1).

What is in hand. Each input buffer mrasrc takes is a sample, taken before its frames count: `total`, where the
audio in hand ends, in the sink's frames (the sink's next write, what waits in the queue after mrasrc, the queue
before it where one is named: the Audio Decoder's, and this buffer), and `consumed`, the first frame the device
can still play (sink_margin_ref.consumed_frames, the guard held). Between buffers what is in hand only falls, by
what the device plays, unless more arrives in a queue before mrasrc, so the least it was since the last sample is
min(total, the last sample's total) less `consumed` now; with no queue before mrasrc that is exact. `due`, where
given, is how late (in frames) the content at `consumed` already is: audio held that is not yet due is no excess
(a feed that runs ahead, the drift test's), so a sample is the lesser of the two.

The trough. The excess is the least sample over the last WINDOW_MS (60 s) less the margin: a feed whose lateness
walks (the field's 30-70 ms at load, MR-057) keeps the room its worst moment in the window used, so it gets no
hole on its next rise. 60 s holds that walk's swings (seconds) and five turns of MR-057's 12 s relaunch loop; 30 s
gave a 30-300 ms walk 2 holes more than no catch-up in ten 600 s model runs and one on a real pulsesink, 60 s none.
Only an excess that held for a whole window is played out: a run waits WINDOW_MS after each reset before it may
start. Samples are kept with what was removed so far added back, so the catch-up's own removal does not read as a
lateness rise; the excess is that trough less what was removed since.

The command. Idle -> catching-up once the excess is START_MS (20 ms) or more (less is not worth a pitch move);
catching-up while it stays above 0, so it ends at the margin (a sample per buffer: past it by at most the rate
times a buffer), and a new rise mid-way lowers the trough and ends it early. The command (ppb) multiplies the
device term's ratio: each output frame carries 1 + ppb of content, so what is in hand falls by frames x ppb, the
count of what was removed. A reset (a start, a flush, new caps: the sink starts again) clears the window.

API:
    c = CatchUp(margin_frames, rate_hz, ppb=RATE_PPM * 1000, window_ns=WINDOW_MS * MS, start_frames=None)
    c.reset(t_ns)
    c.sample(t_ns, total, consumed, due=None) -> the command (ppb, 0 or ppb) for this buffer's output
    c.produced(frames, ppb)        the output made under that command
    c.state() -> "watching" (less than a window since the reset), "idle" or "catching-up"
    c.excess -> the last sample's excess (frames, 0 while watching); c.removed() -> frames removed so far
Run as a script it reads one JSON object per line and prints one per line, the format `mrts_cli catch-up` reads:
{"margin", "hz", "ppb"?, "window"?, "start"?} (a new catch-up, reset at 0) -> {"ok": 1}; {"reset": t} -> {"ok": 1};
{"t", "total", "consumed", "due"?} -> {"cmd", "excess", "state"}; {"produced", "ppb"} -> {"removed"}:
    catch_up_ref.py cases.jsonl|-
"""
import collections
import json
import sys

MS = 1_000_000
WINDOW_MS = 60_000
RATE_PPM = 5_000              # 0.5 %: the owner's drain rate
START_MS = 20
E9 = 1_000_000_000


class CatchUp:
    def __init__(self, margin_frames, rate_hz, ppb=RATE_PPM * 1000, window_ns=WINDOW_MS * MS, start_frames=None):
        self.margin = max(0, int(margin_frames))
        self.ppb = min(max(0, int(ppb)), RATE_PPM * 1000)
        self.window = max(0, int(window_ns))
        hz = max(1, int(rate_hz))
        self.start = START_MS * hz // 1000 if start_frames is None else max(1, int(start_frames))
        self.removed_frames = 0
        self.removed_frac = 0        # ppb of a frame, [0, 1e9)
        self.reset(0)

    def reset(self, t_ns):
        self.win = collections.deque()   # (t, sample + removed then), the samples increasing
        self.since = t_ns
        self.active = False
        self.prev = None
        self.excess = 0

    def removed(self):
        return self.removed_frames

    def sample(self, t_ns, total, consumed, due=None):
        low = total if self.prev is None else min(total, self.prev)
        self.prev = total
        s = low - consumed
        if due is not None:
            s = min(s, due)
        a = s + self.removed_frames
        while self.win and self.win[-1][1] >= a:
            self.win.pop()
        self.win.append((t_ns, a))
        while self.win[0][0] < t_ns - self.window:
            self.win.popleft()
        if t_ns - self.since < self.window:
            self.excess = 0
            self.active = False
            return 0
        self.excess = self.win[0][1] - self.removed_frames - self.margin
        self.active = self.excess > 0 if self.active else self.excess >= self.start
        return self.ppb if self.active and self.ppb else 0

    def produced(self, frames, ppb):
        if frames <= 0 or ppb <= 0:
            return
        f = self.removed_frac + frames * ppb
        self.removed_frames += f // E9
        self.removed_frac = f % E9

    def state(self):
        if self.active:
            return "catching-up"
        return "idle" if self.win and self.win[-1][0] - self.since >= self.window else "watching"


def main(argv):
    if len(argv) != 2:
        print("usage: catch_up_ref.py cases.jsonl|-", file=sys.stderr)
        return 2
    f = sys.stdin if argv[1] == "-" else open(argv[1])
    c = CatchUp(0, 48000)
    for raw in f:
        raw = raw.strip()
        if not raw:
            continue
        e = json.loads(raw)
        if "margin" in e:
            c = CatchUp(e["margin"], e["hz"], e.get("ppb", RATE_PPM * 1000), e.get("window", WINDOW_MS * MS),
                        e.get("start"))
            out = {"ok": 1}
        elif "reset" in e:
            c.reset(e["reset"])
            out = {"ok": 1}
        elif "produced" in e:
            c.produced(e["produced"], e["ppb"])
            out = {"removed": c.removed()}
        else:
            cmd = c.sample(e["t"], e["total"], e["consumed"], e.get("due"))
            out = {"cmd": cmd, "excess": c.excess, "state": c.state()}
        print(json.dumps(out, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
