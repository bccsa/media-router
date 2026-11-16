#!/usr/bin/env python3
"""The Python reference of mrts::DrainServo (ch. 15.4 B-179, WI-P4-18, issue #862): how fast a
device output plays its built-up latency back down to the smallest buffer that plays clean. Built
first here (OQ-1); ../native/mrts/drain_servo.{h,cpp} ports it with output parity, decision for
decision. A reference only: nothing loads it at runtime. drain_servo_test.py is its suite.

Times are ns on the element's clock (the device tick's house time, or a video frame's arrival);
integer arithmetic throughout, so the C++ agrees exactly. Rates are ppb: +5,000,000 is 0.5 %.

The measure. A slack sample is content that was ready at the device element before it was
needed: the audio fill downstream of mrasrc less the prefill's delay line, a video frame's lead
on its drained slot (plus `vp_esq`'s level, a second window). The trough F is the minimum of the
samples over 3 buckets of 10 s, the newest open (CoDel's standing-queue test, used to speed up
instead of drop); F is the slack's trough plus the level's where both are fed.

The law. Excess E = F - m (m the margin). The command E' is E alone (never below 0: alone it only
drains), or, in a group whose target P (any value above -1 h: early outputs group below 0) was
refreshed within 10 s, E' = L - min(P, T + 1 s) where L
is the render lateness and T the published target: min(E, E') when that is >= 0 (never below its
own target), else E' (it rises to the group). delta* = clamp(E' / 30 s, +-0.5 %) while engaged:
it engages at |E'| >= 20 ms and lets go at |E'| <= 5 ms. delta slews at most 500 ppm/s, except at
an epoch break (a DISCONT or GAP), where it steps. No drain until 30 s were sampled since the last
window clear (a relock, a stall's flush, caps, a flush, PAUSED), nor while an episode runs, nor for
30 s after an audio starvation or an outage (its zeros are in the window). A sample below 0 (content that was late) reads
0: the slack is what was early.

The margin. Audio starts at its 20 ms floor (the live fill sits at the prefill's delay line: no
ring margin to keep), video at its floor, 1 frame; ceiling 500 ms. Only a steady audio starvation
the margin limited raises it (B-240, owner decision 2026-11-13): one of at most 250 ms is judged
10 s after its end (t_c) and raises there only if (S1) the servo was warm at its start (window
full, no starvation hold), (S2) delta was 0 from 30 s before its start to t_c, (S3) no epoch
break, outage or window clear from 30 s before its start to t_c, (S4) the render lateness at t_c
is at most its start's + the episode's length + 20 ms, and (S6) the trough 1-2 s before its start
(the fill's own fall into it left out) was within the margin +- 20 ms; a longer one is an outage, counted apart. Each that does not raise counts under
its first failed test: drain (delta != 0 in it), after-drain (within 30 s after), warm-up, input,
load, not-margin. A video late release raises it only while delta > 0 or within 30 s after delta
last was (B4); others count as `video`. Late frames within 1 s of the last are one episode; one
more than 250 ms late is an outage. A raise: L = m_u (the margin
that underran), m = min(500 ms, max(2 m_u, m_u + 20 ms)).
Every 10 min without a raise m falls 5 ms, never below the floor nor L + 10 ms (L once it exists);
every hour L falls 5 ms, down to floor - 10 ms.

Published target T (the group's input): L - max(E, 0) while it can drain (a trough under the
margin never lifts the group); its render lateness while it
cannot (warm-up, after a starvation, no lock, no display rate); held at its value when a rise began
while delta < 0.

Run as a script it replays a sequence (the format `mrts_cli drain` reads):
    drain_servo.py seq.jsonl|-
one JSON object per line: {"op":"config","video":0|1,"start":ns,"floor":ns} starts a new servo
(other keys are labels), {"op":"sample","now":ns,"slack":ns}, {"op":"queue","now":ns,"level":ns},
{"op":"starve","now":ns,"on":0|1}, {"op":"late","now":ns,"by":ns}, {"op":"clear","now":ns},
{"op":"break"}, {"op":"group","now":ns,"target":ns} and {"op":"update","now":ns,"render":ns,
"can":0|1}. Each update prints its events, then one state line (keys in this order):
{"event":kind,"at":ns,"value":ns} (drain-start: the command; drain-done: drained so far;
underrun: the episode's length; raise: the new margin; outage: its length) and
{"ppb":n,"excess":ns,"margin":ns,"learned":ns,"trough":ns,"target":ns,"drained":ns,"raises":n,
"underruns":n,"outages":n,"state":s,"capped":0|1,"reasons":[n,...]} (learned -1 before any raise;
reasons: the counts in REASONS' order). An underrun event carries its "reason" (raised, or the
first failed test), judged at t_c for audio; a raise its evidence: "from" (m_u), "length",
"trough" (at the episode's start) and "steady" (ns since delta, a break or a clear last moved).
"""
import json
import sys

SEC = 1000000000
MS = 1000000
BUCKET_NS = 10 * SEC
BUCKETS = 3
WINDOW_NS = BUCKETS * BUCKET_NS
TAU_NS = 30 * SEC
DMAX_PPB = 5000000                    # 0.5 %, the owner's (9 Nov)
SLEW_DEN = 2000                       # 500 ppm/s: dt / 2000 ppb per ns of dt
ENGAGE_NS = 20 * MS
LETGO_NS = 5 * MS
CEILING_NS = 500 * MS
SHORT_NS = 250 * MS                   # an audio starvation up to this raises; longer: an outage
JOIN_NS = SEC                         # video late frames this close are one episode
M_EVERY_NS = 600 * SEC
L_EVERY_NS = 3600 * SEC
STEP_NS = 5 * MS                      # each decay step, of m and of L
ABOVE_L_NS = 10 * MS                  # m stays this far above L
UNDER_FLOOR_NS = 10 * MS              # L decays to floor - this
RAISE_MIN_NS = 20 * MS
GROUP_STALE_NS = 10 * SEC
RISE_CAP_NS = SEC
GROUP_ALONE_NS = -3600 * SEC          # the group target that means alone; any other, even <= 0, groups
AUDIO_START_NS = 20 * MS
AUDIO_FLOOR_NS = 20 * MS
CONFIRM_NS = 10 * SEC                 # C: an audio starvation is judged this long after its end (B-240)
QUIET_NS = WINDOW_NS                  # Q: delta 0 this long before it (the window still holds the drain's fill)
LIMIT_BAND_NS = ENGAGE_NS             # S6: its start trough within the margin +- this, both edges in
KEEP_UP_NS = 20 * MS                  # S4: render lateness may grow by the episode's length + this
SETTLE_NS = SEC                       # S6 reads the trough 1-2 s before the start: not the fill's own descent
REASONS = ("drain", "after-drain", "video", "warm-up", "input", "load", "not-margin")


def tdiv(a, b):
    """a / b truncated toward 0 (C++'s), b > 0."""
    return -((-a) // b) if a < 0 else a // b


def clamp(v, lo, hi):
    return lo if v < lo else hi if v > hi else v


class Window:
    """The minimum over 3 buckets of 10 s on the servo's clock, the newest open."""

    def __init__(self):
        self.clear(0)

    def clear(self, now):
        self.open_at = now
        self.mins = [None]

    def _rotate(self, now):
        if now - self.open_at < BUCKET_NS:
            return
        k = (now - self.open_at) // BUCKET_NS
        self.open_at += k * BUCKET_NS
        if k >= BUCKETS:
            self.mins = [None]
            return
        self.mins.extend([None] * k)
        del self.mins[:-BUCKETS]

    def add(self, now, v):
        self._rotate(now)
        if self.mins[-1] is None or v < self.mins[-1]:
            self.mins[-1] = v

    def min(self, now):
        self._rotate(now)
        vals = [m for m in self.mins if m is not None]
        return min(vals) if vals else None


class DrainServo:
    def __init__(self, video=False, start_ns=AUDIO_START_NS, floor_ns=AUDIO_FLOOR_NS):
        self.video = video
        self.floor = floor_ns
        self.margin = start_ns
        self.learned = None
        self.slack = Window()
        self.queue = Window()
        self.started = False
        self.ppb = 0
        self.engaged = False
        self.draining = False
        self.brk = False
        self.episode_at = None      # audio: the episode's first starving tick
        self.late_at = None         # video: the last late frame of the episode
        self.positive_at = None     # when delta last was > 0
        self.hold_until = None      # no drain before: a starvation's zeros are in the window
        self.group = GROUP_ALONE_NS
        self.group_at = 0
        self.held = 0
        self.target = 0
        self.excess = 0
        self.trough = 0
        self.capped = False
        self.state = "warm-up"
        self.drained = self.drained_rem = 0
        self.raises = self.underruns = self.outages = 0
        self.events = []
        self.reasons = dict.fromkeys(REASONS, 0)
        self.nonzero_at = None      # the last instant delta was != 0
        self.broken_at = None       # the last epoch break, outage or window clear
        self.pending = []           # audio episodes awaiting t_c
        self.render = 0             # the last update's render lateness
        self.episode = None         # audio: what the running episode's start saw
        self.settled = None         # the trough 1-2 s ago (S6), and the newer one waiting its turn
        self.next_trough = None
        self.next_at = None

    def _touch(self, now):
        if self.started:
            return
        self.started = True
        self.warm_from = self.last = now
        self.sampled = False        # a slack sample since the last clear
        self.slack.clear(now)
        self.queue.clear(now)
        self.m_at = now + M_EVERY_NS
        self.l_at = None

    def _bound(self):
        if self.learned is None:
            return self.floor
        return min(CEILING_NS, max(self.floor, self.learned + ABOVE_L_NS))

    def _decay(self, now):
        # The two decays in time order, L first at a tie.
        while True:
            l_due = self.l_at is not None and self.l_at <= now
            m_due = self.m_at <= now
            if l_due and (not m_due or self.l_at <= self.m_at):
                self.learned = max(self.floor - UNDER_FLOOR_NS, self.learned - STEP_NS)
                self.l_at += L_EVERY_NS
            elif m_due:
                self.margin = max(self._bound(), self.margin - STEP_NS)
                self.m_at += M_EVERY_NS
            else:
                return

    def _raise(self, now, length, trough, steady):
        mu = self.margin
        self.learned = mu
        self.margin = min(CEILING_NS, max(2 * mu, mu + RAISE_MIN_NS))
        self.raises += 1
        self.m_at = now + M_EVERY_NS
        self.l_at = now + L_EVERY_NS
        self.events.append(("raise", now, self.margin, (mu, length, trough, steady)))

    def _trough(self, now):
        """The window's trough: the slack's, plus the queue's level where both are fed."""
        trough = self.slack.min(now)
        q = self.queue.min(now)
        if trough is not None and q is not None:
            trough += q
        return trough

    def _count(self, now, reason, length):
        self.reasons[reason] += 1
        self.events.append(("underrun", now, length, reason))

    def sample(self, now, slack_ns):
        self._touch(now)
        if self.sampled and self.slack.min(now) is None:
            self.warm_from = now    # a hole emptied the window: warm-up again (B-179 fix 2)
        self.sampled = True
        self.slack.add(now, max(slack_ns, 0))

    def queue_level(self, now, level_ns):
        self._touch(now)
        self.queue.add(now, max(level_ns, 0))

    def _outage(self, now, length):
        self.outages += 1
        self.hold_until = now + WINDOW_NS
        self.broken_at = now
        self.events.append(("outage", now, length))

    def starve(self, now, on):
        """Audio, each tick: whether the device starved since the last one."""
        self._touch(now)
        if on and self.episode_at is None:
            self.episode_at = now
            # S1 as the window and the hold judge it, not the lock: the starvation itself can stop the
            # render lateness reading (`can`) on the tick before it is detected.
            warm = (self.sampled and now - self.warm_from >= WINDOW_NS
                    and (self.hold_until is None or now >= self.hold_until))
            self.episode = {"start": now, "render": self.render, "trough": self.settled,
                            "margin": self.margin, "warm": warm, "drain": self.ppb != 0,
                            "quiet": self.nonzero_at}
        elif not on and self.episode_at is not None:
            length = now - self.episode_at
            self.episode_at = None
            if length <= SHORT_NS:
                self.hold_until = now + WINDOW_NS
                self.underruns += 1
                ep = dict(self.episode, length=length, tc=now + CONFIRM_NS)
                ep["drain"] = ep["drain"] or self.ppb != 0
                self.pending.append(ep)
            else:
                self._outage(now, length)
            self.episode = None

    def _judge(self, now, ep, render_ns):
        """S1-S4, S6 at t_c (B-240): raise, or count under the first test that fails."""
        start = ep["start"]
        if ep["drain"]:
            reason = "drain"
        elif ep["quiet"] is not None and ep["quiet"] >= start - QUIET_NS:
            reason = "after-drain"
        elif not ep["warm"]:
            reason = "warm-up"
        elif self.broken_at is not None and self.broken_at >= start - WINDOW_NS:
            reason = "input"
        elif render_ns > ep["render"] + ep["length"] + KEEP_UP_NS:
            reason = "load"
        elif ep["trough"] is None or abs(ep["trough"] - ep["margin"]) > LIMIT_BAND_NS:
            reason = "not-margin"
        else:
            since = max(t for t in (self.nonzero_at, self.broken_at, self.warm_from) if t is not None)
            self.events.append(("underrun", now, ep["length"], "raised"))
            self._raise(now, ep["length"], ep["trough"], start - since)
            return
        self._count(now, reason, ep["length"])

    def late(self, now, by_ns):
        """Video: a release `by_ns` later than its drained slot, neither collapsed nor sink-late. B4 stays
        (B-240 withheld its video half): it raises while delta > 0 or within 30 s after; else `video`."""
        self._touch(now)
        joins = self.late_at is not None and now - self.late_at <= JOIN_NS
        self.late_at = now
        if by_ns > SHORT_NS:
            self._outage(now, by_ns)
            return
        if joins:
            return
        self.underruns += 1
        recent = self.positive_at is not None and now - self.positive_at <= WINDOW_NS
        if self.ppb > 0 or recent:
            self.events.append(("underrun", now, 0, "raised"))
            self._raise(now, 0, None, 0)
        else:
            self._count(now, "video", 0)

    def clear(self, now):
        """A window clear: warm-up again, delta 0; the margin and L stay."""
        self._touch(now)
        self.slack.clear(now)
        self.queue.clear(now)
        self.warm_from = now
        self.sampled = False
        self.ppb = 0
        self.engaged = False
        if self.draining:
            self.events.append(("drain-done", now, self.drained))
        self.draining = False
        self.episode_at = None
        self.episode = None
        self.late_at = None
        self.hold_until = None
        self.broken_at = now
        self.settled = self.next_trough = self.next_at = None
        for ep in self.pending:     # judged at once: a clear inside [start - W, t_c] is S3's
            self._count(now, "input", ep["length"])
        self.pending = []

    def epoch_break(self):
        self.brk = True

    def set_group(self, now, target_ns):
        self._touch(now)
        self.group = target_ns
        self.group_at = now

    def update(self, now, render_ns, can):
        self._touch(now)
        self._decay(now)
        dt = max(now - self.last, 0)
        self.last = now
        if self.ppb > 0:
            acc = self.ppb * dt + self.drained_rem
            self.drained += acc // SEC
            self.drained_rem = acc % SEC
        if self.ppb != 0:           # delta held its value until now
            self.nonzero_at = now
            if self.episode is not None:
                self.episode["drain"] = True
            for ep in self.pending:
                ep["drain"] = True
        if self.brk:
            self.broken_at = now
        while self.pending and self.pending[0]["tc"] <= now:
            self._judge(now, self.pending.pop(0), render_ns)
        trough = self._trough(now)
        if self.next_at is None or now - self.next_at >= SETTLE_NS:
            self.settled, self.next_trough, self.next_at = self.next_trough, trough, now
        warm = (bool(can) and trough is not None and now - self.warm_from >= WINDOW_NS
                and (self.hold_until is None or now >= self.hold_until))
        self.trough = trough if trough is not None else 0
        excess = trough - self.margin if warm else 0
        self.excess = excess
        t_now = render_ns - max(excess, 0)
        if self.ppb >= 0:
            self.held = t_now
        self.target = self.held if self.ppb < 0 else t_now
        grouped = self.group > GROUP_ALONE_NS and now - self.group_at <= GROUP_STALE_NS
        self.capped = False
        if not warm or self.episode_at is not None:
            cmd = 0
        elif grouped:
            goal = min(self.group, self.target + RISE_CAP_NS)
            self.capped = self.group > self.target + RISE_CAP_NS
            eg = render_ns - goal
            cmd = max(0, min(excess, eg)) if eg >= 0 else eg
        else:
            cmd = max(0, excess)
        if self.engaged and abs(cmd) <= LETGO_NS:
            self.engaged = False
        elif not self.engaged and abs(cmd) >= ENGAGE_NS:
            self.engaged = True
        # Saturated from 150 ms: a command past 1 s gives the same, and keeps cmd * 1e9 in 64 bits.
        want = 0
        if self.engaged:
            want = clamp(tdiv(clamp(cmd, -SEC, SEC) * SEC, TAU_NS), -DMAX_PPB, DMAX_PPB)
        draining = self.engaged and cmd > 0
        if draining and not self.draining:
            self.events.append(("drain-start", now, cmd))
        elif self.draining and not draining:
            self.events.append(("drain-done", now, self.drained))
        self.draining = draining
        if self.brk:
            self.ppb = want
            self.brk = False
        else:
            step = dt // SLEW_DEN
            self.ppb = clamp(want, self.ppb - step, self.ppb + step)
        if self.ppb > 0:
            self.positive_at = now
        if self.ppb != 0:
            self.nonzero_at = now
        self.render = render_ns
        self.state = ("warm-up" if not warm else "draining" if self.ppb > 0
                      else "rising" if self.ppb < 0 else "idle")
        return self.ppb

    def take_events(self):
        ev, self.events = self.events, []
        return ev


def line(obj):
    return json.dumps(obj, separators=(",", ":"))


def event_line(ev):
    kind, at, value = ev[:3]
    d = {"event": kind, "at": at, "value": value}
    if kind == "underrun":
        d["reason"] = ev[3]
    elif kind == "raise":
        d["from"], d["length"], d["trough"], d["steady"] = ev[3]
    return line(d)


def state_line(s):
    return line({"ppb": s.ppb, "excess": s.excess, "margin": s.margin,
                 "learned": -1 if s.learned is None else s.learned, "trough": s.trough,
                 "target": s.target, "drained": s.drained, "raises": s.raises,
                 "underruns": s.underruns, "outages": s.outages, "state": s.state,
                 "capped": int(s.capped), "reasons": [s.reasons[r] for r in REASONS]})


def replay(lines, out):
    s = DrainServo()
    for text in lines:
        text = text.strip()
        if not text:
            continue
        op = json.loads(text)
        k = op["op"]
        if k == "config":
            video = bool(op.get("video", 0))
            s = DrainServo(video, op.get("start", AUDIO_START_NS), op.get("floor", AUDIO_FLOOR_NS))
        elif k == "sample":
            s.sample(op["now"], op["slack"])
        elif k == "queue":
            s.queue_level(op["now"], op["level"])
        elif k == "starve":
            s.starve(op["now"], bool(op["on"]))
        elif k == "late":
            s.late(op["now"], op["by"])
        elif k == "clear":
            s.clear(op["now"])
        elif k == "break":
            s.epoch_break()
        elif k == "group":
            s.set_group(op["now"], op["target"])
        elif k == "update":
            s.update(op["now"], op["render"], bool(op["can"]))
            for ev in s.take_events():
                out.write(event_line(ev) + "\n")
            out.write(state_line(s) + "\n")
        else:
            raise ValueError("unknown op %r" % k)


def main(argv):
    if len(argv) != 2:
        sys.stderr.write("usage: drain_servo.py seq.jsonl|-\n")
        return 2
    src = sys.stdin if argv[1] == "-" else open(argv[1])
    with src:
        replay(src, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
