#!/usr/bin/env python3
"""mrts::DrainServo against its reference (ch. 15.4 B-179, WI-P4-18): `mrts_cli drain` replays a call
sequence in drain_servo.py's line format, and every event and state line it prints must equal
drain_servo.py's, line for line, on

  - the suite's sequences: drain_servo_test.py's cases as a recording servo writes them;
  - 120 random ones (seeded): slack and queue samples, starvation episodes of 0.1 to 3 s, late
    frames 0 to 400 ms late, clears, breaks, group targets (fresh, stale, below 0 or alone) and updates with
    and without a lock, over 5 to 40 min with gaps in the ticks.

Then each of the reference's servo mutants replays the same sequences, and parity must tell it from
mrts_cli. Skips (exit 0) without the built mrts_cli (make native).

Run:  python3 drain_servo_parity_test.py
"""
import io
import os
import subprocess
import sys
import tempfile

import drain_servo as ds
import drain_servo_test as dt

HERE = os.path.dirname(os.path.abspath(__file__))
CLI = os.path.join(HERE, "..", "native", "mrts", "mrts_cli")
SEC, MS = ds.SEC, ds.MS
RANDOM_RUNS = 120

_failures = 0


def check(name, cond):
    global _failures
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        _failures += 1


class Recorded(ds.DrainServo):
    """A servo that writes each call as an op of the replay format, one sequence per servo."""
    made = []

    def __init__(self, video=False, start_ns=ds.AUDIO_START_NS, floor_ns=ds.AUDIO_FLOOR_NS):
        super().__init__(video, start_ns, floor_ns)
        self.out = io.StringIO()
        Recorded.made.append(self)
        self._w({"op": "config", "video": int(video), "start": start_ns, "floor": floor_ns})

    def _w(self, op):
        self.out.write(ds.line(op) + "\n")

    def sample(self, now, slack_ns):
        self._w({"op": "sample", "now": now, "slack": slack_ns})
        super().sample(now, slack_ns)

    def queue_level(self, now, level_ns):
        self._w({"op": "queue", "now": now, "level": level_ns})
        super().queue_level(now, level_ns)

    def starve(self, now, on):
        self._w({"op": "starve", "now": now, "on": int(on)})
        super().starve(now, on)

    def late(self, now, by_ns):
        self._w({"op": "late", "now": now, "by": by_ns})
        super().late(now, by_ns)

    def clear(self, now):
        self._w({"op": "clear", "now": now})
        super().clear(now)

    def epoch_break(self):
        self._w({"op": "break"})
        super().epoch_break()

    def set_group(self, now, target_ns):
        self._w({"op": "group", "now": now, "target": target_ns})
        super().set_group(now, target_ns)

    def update(self, now, render_ns, can):
        self._w({"op": "update", "now": now, "render": render_ns, "can": int(bool(can))})
        return super().update(now, render_ns, can)


def suite_ops():
    """The cases' calls, one sequence per servo (a group case runs three at once)."""
    seqs = []
    for name, fn in dt.CASES.items():
        Recorded.made = []
        dt.DrainServo = Recorded
        try:
            fn()
        finally:
            dt.DrainServo = ds.DrainServo
        seqs.append((name, [r.out.getvalue() for r in Recorded.made]))
    return seqs


class Lcg:
    def __init__(self, seed):
        self.x = seed

    def int(self, lo, hi):
        self.x = (self.x * 6364136223846793005 + 1442695040888963407) % (1 << 64)
        return lo + (self.x >> 33) % (hi - lo + 1)


def random_ops(seed):
    r = Lcg(seed)
    video = r.int(0, 1)
    ops = [{"op": "config", "video": video, "start": r.int(20, 120) * MS,
            "floor": r.int(10, 40) * MS}]
    t = r.int(0, 1000) * SEC
    end = t + r.int(5, 40) * 60 * SEC
    fill = r.int(0, 3000) * MS
    render = r.int(-800, 500) * MS + fill
    group = ds.GROUP_ALONE_NS
    while t < end:
        t += 100 * MS if r.int(0, 50) else r.int(1, 120) * SEC
        k = r.int(0, 99)
        fill = max(0, fill + r.int(-30, 30) * MS // 10 - (fill // 400 if k < 50 else 0))
        render = max(-SEC, render + r.int(-20, 20) * MS // 10)
        ops.append({"op": "sample", "now": t, "slack": fill - r.int(0, 80) * MS})
        if video and k < 30:
            ops.append({"op": "queue", "now": t, "level": r.int(0, 2000) * MS})
        if not video and k < 3:
            ops.append({"op": "starve", "now": t, "on": 1})
            t += r.int(1, 30) * 100 * MS
            ops.append({"op": "starve", "now": t, "on": 0})
        if video and k < 4:
            ops.append({"op": "late", "now": t, "by": r.int(0, 400) * MS})
        if k == 97:
            ops.append({"op": "clear", "now": t})
        if k == 98:
            ops.append({"op": "break"})
        if k >= 90 or not r.int(0, 20):
            group = ds.GROUP_ALONE_NS if k == 99 else render + r.int(-300, 1500) * MS
            ops.append({"op": "group", "now": t, "target": group})
        ops.append({"op": "update", "now": t, "render": render, "can": int(r.int(0, 30) > 0)})
    return "".join(ds.line(o) + "\n" for o in ops)


def run_cli(text):
    with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as f:
        f.write(text)
        path = f.name
    try:
        p = subprocess.run([CLI, "drain", path], capture_output=True, text=True, timeout=600)
    finally:
        os.unlink(path)
    return p.returncode, p.stdout, p.stderr


def run_ref(text):
    out = io.StringIO()
    ds.replay(text.splitlines(), out)
    return out.getvalue()


SERVO_MUTANTS = [m for m in dt.MUTANTS if m[0] not in ("P as the min",)]


def main():
    if not os.access(CLI, os.X_OK):
        print("SKIP mrts_cli not built (make native)")
        return 0
    seqs = suite_ops()
    seqs += [("random-%d" % i, [random_ops(1000 + i)]) for i in range(RANDOM_RUNS)]
    ref_out = {}
    for name, parts in seqs:
        rc_all, ok = 0, True
        for j, part in enumerate(parts):
            rc, cli_out, err = run_cli(part)
            ref = run_ref(part)
            ref_out[(name, j)] = (part, ref)
            rc_all |= rc
            if rc or cli_out != ref:
                ok = False
                if rc:
                    print("  cli failed: %s" % err.strip()[:200])
                else:
                    diff = next(i for i, (a, b) in enumerate(zip(cli_out.splitlines(), ref.splitlines()))
                                if a != b) if cli_out.splitlines()[:1] else 0
                    print("  first difference at output line %d" % diff)
        check("parity: %s (%d servo(s))" % (name, len(parts)), ok)
    for label, patch, _case in SERVO_MUTANTS:
        undo = patch()
        try:
            told = any(run_ref(part) != ref for part, ref in ref_out.values())
        finally:
            undo()
        check("parity tells the mutant: %s" % label, told)
    if _failures:
        print("\n%d FAILURE(S) in drain_servo_parity_test" % _failures)
        return 1
    print("\nALL drain_servo_parity_test TESTS PASSED")
    return 0



if __name__ == "__main__":
    sys.exit(main())
