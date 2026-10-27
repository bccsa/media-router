#!/usr/bin/env python3
"""The Python reference of mrasrc's device term (plan ch. 8 part 4.3 and WI-P4-4, ch. 15.4 B-165):
how the one ASRC of an audio output follows its device once the sink runs sync=false, what it does
when the device stops taking data (Q2: skip, resume live), and its render lateness. Built first
here (p4-4a) on the sink clocks DEV-P4a recorded (../tests/fixtures/clock/); p4-4b ports it into
mrts::AsrcServo and mrasrc with parity, the lock being mrts::ClockLock itself (clock_lock.py is its
exact port). A reference only: nothing loads it at runtime (ADR-0029 choice 1, plan OQ-1).

Evidence. Every sample_ns (100 ms) a timer reads the device sink's provided clock (pulsesink's is
pa_stream_get_time, the stream time of the sample at the device), then CLOCK_MONOTONIC (house
time): a preemption between the two reads makes a pair late, which the lower envelope ignores. The
pair feeds a ClockLock (remote = device time, arrival = house time) under device_lock_config(); its
eps (house ns per device ns, less 1, in ppb) is eps_dev, its line the device's phase. Nothing else
reaches the lock: never a queue level, the ring's fill or the prefill.
  - Reads run only between start() and stop(): from the first buffer the sink renders after it
    acquired its ring to the next release (READY, a caps change). A read of pulsesink's clock while
    it acquires kills the stream ("Disconnected: OK" in 14 of 15 starts on the Pi 4 test box, 0 of
    15 when the reads began at the first rendered buffer, DEV-P4a). The clock's flat start (0 for
    100-500 ms) lies wholly before the first write in all four recorded clocks.
  - The lock begins settle_ns (15 s) after the clock first moves, and again after every relock:
    from a start pulsesink's interpolation runs slow for 3-5 s (25-42 ms behind its steady level on
    the null sinks) and corrects itself by +10..+23 ms every 1.5 s until about 13 s. In the fits it
    bends the rate (a 5 s settle: 12-24 ms of fill drift in the hour on three of the four sinks); to
    a line seeded on the first sample it is 49 ms on the Pi 4's HDMI-linked sink, 1 ms under 50.
  - A sample whose clock moved less than a tenth of the house time since the last is flat and never
    fed: a clock that stalls (in an underrun, a stopped device) must not read as a slow device. The
    recorded clocks run on through a 300 ms hole and a 1 s underrun; none is flat once running.
  - A fed sample whose residual (house - line(device)) lies past +-relock_ns (50 ms), relock_samples
    (2) in a row, or ClockLock's own envelope step, is a device-clock step: relock (the rate kept),
    event relock-device reason step, settle again. A start after a stop() relocks the same way,
    reason restart: the stream's clock starts again from 0. The interpolation's own corrections in
    steady state are +4..+7 and -4..-6 ms, every 1.5 s.
Ratio. ratio_ppb(eps_in) = (1 + eps_in) / (1 + eps_dev) - 1, rounded, clamped to +-ratio_max_ppm,
both eps in ClockLock's sense (eps_in is the input's term, 0 on house-rate content): a device 135
ppm slow (eps_dev +135 ppm) gets 135 ppm fewer output samples. eps_dev is 0 until the lock has a
rate. No phase term: the ratio follows the device's rate only, so a stall that leaves a backlog
never moves it and the backlog stays until a gap (ch. 8 part 4.3); the fill drifts by the rate
error's integral, the acquisition's mostly (2.4-7.7 ms over the four recorded clocks).
Device stall (Q2: skip, resume live). The element counts the samples it pushed downstream and the
samples that reached the device sink's pad (a probe there, which also gives the first rendered
buffer). A device that stops taking data blocks the sink's render, its clock stopped or (a removed
PipeWire node, DEV-P4a case 8) running on, so the rule reads the render, never the clock (and the
ratio never reads the counts):
  - stalled: for stall_ns (1 s) the sink took nothing while more than waiting_ns of samples waited
    for it (pushed less taken, beyond the 40 ms the prefill holds back): event device-stalled, and
    the timer flushes downstream (FLUSH_START/STOP from the src pad: the prefill, the ring and a
    blocked push hold only what no one can hear). The streaming thread keeps pushing live input;
    while the device stays stopped what reaches downstream is flushed every probe_ns (500 ms).
  - resumed: since the last flush the sink took more than an empty ring holds (resume_ns): the
    device consumes. Event device-resumed, one more flush (what queued while it was stopped), and
    live input plays. Counted: device-stalls; dropped, the samples pushed that the sink never took
    plus those it took into a ring the stopped device never read (not the ring's content when the
    device stopped, which the element cannot see).
Render lateness: now - PTS(the sample at the device). The device clock gives its position in the
ring (samples); each rendered buffer's write position is the base sink's next_sample after its
render, less its samples, so a realign (an underflow, a flush) moves the map with the sink. Not the
plan's out_pushed - fill: after a 300 ms hole on the Pi 5 test box the base sink realigns its next
write on a read index 29-53 ms stale, the server drops 100-127 ms of writes behind its read index,
then the base sink realigns 40 ms ahead (DEV-P4a case 6); a count of pushed samples stays that far
off after every such hole. A buffer written wholly behind the device's position is never heard and
stays out of the map; where the clock lags the server's read index (a device's own latency), the
writes the server drops between the two cannot be told from the clock.

API:
    term = DeviceTerm(device_term_config())
    term.start(mono_ns) -> events      the first rendered buffer after the sink acquired its ring
    term.stop(mono_ns)                 the ring released
    term.sample(dev_ns, mono_ns, pushed=None, rendered=None) -> (events, flush)
    term.ratio_ppb(eps_in_ppb=0), term.device_ppb(), term.lock_state(), term.stats()
    acc = RenderLateness(rate_hz)
    acc.rendered(write_pos, n, pts_ns, heard_pos=None); acc.flush(); acc.at(now_ns, dev_ns) -> ns|None
Run as a script it replays a recorded clock or a call sequence (the format p4-4b's
`mrts_cli asrc-device` reads):
    asrc_device_ref.py seq.jsonl|-
In: tools/output-check/sink_clock_trace.py's lines (a sample with next_sample >= 0 is rendered:
start() before the first after a stop(); a "restart" event is stop(); other lines are ignored), or
ops: {"op":"config", <DeviceTermConfig fields>, "lock":{<ClockLockConfig fields>}} starts a new
term (other keys are labels), {"op":"start","mono":ns}, {"op":"stop","mono":ns},
{"op":"sample","dev":ns,"mono":ns[,"pushed":n,"rendered":n][,"in_ppb":ppb]}. Out, compact, keys in
this order: each event {"event":kind,...}; per sample {"mono":ns,"lock":state,"dev_ppb":ppb,
"ratio_ppb":ppb,"stalled":0|1,"flush":0|1}; at each term's end {"summary":{stats}}.
"""
import json
import sys

from clock_lock import E9, ClockLock, asrc_lock_config, clamp

MS = 1000000
SEC = 1000000000


def device_lock_config():
    """The lock on a sink's clock (B-165, from DEV-P4a's clocks): the capture lock's 50 ms two-sided
    step, no backlog rule; a fit window of 1000 buckets (the clamp: on the recorded interpolation
    noise a 300-bucket fit reads 3.6-7.9 ppm sd, a 1000-bucket one 0.35-0.78) and a 1200 s loop; a
    fit is taken at once only past the ratio clamp, so a short fit after a restart never replaces
    the rate kept (at 20 ppm, the capture lock's, it did: 125-286 ppm)."""
    return asrc_lock_config().copy(rate_buckets_max=1000, rate_tau_ns=1200 * SEC, slew_track_ppm=1000)


class DeviceTermConfig:
    def __init__(self, **kw):
        self.sample_ns = 100 * MS        # the timer
        self.settle_ns = 15 * SEC        # after the clock first moves, and after a relock
        self.relock_ns = 50 * MS         # a device-clock step
        self.relock_samples = 2          # ... in this many fed samples in a row
        self.flat_den = 10               # flat: the clock moved under 1/flat_den of house time
        self.stall_ns = 1 * SEC          # the sink took nothing this long while samples waited
        self.waiting_ns = 100 * MS       # samples waiting beyond what the 40 ms prefill holds back
        self.probe_ns = 500 * MS         # while stalled, a flush this often
        self.resume_ns = 200 * MS        # taken since a flush past an empty 100 ms ring: resumed
        self.rate_hz = 48000
        self.ratio_max_ppm = 1000
        self.lock = device_lock_config()
        for k, v in kw.items():
            if not hasattr(self, k):
                raise AttributeError(k)
            setattr(self, k, v)

    def copy(self, **kw):
        c = DeviceTermConfig(**{k: v for k, v in vars(self).items() if k != "lock"})
        c.lock = self.lock.copy()
        for k, v in kw.items():
            if not hasattr(c, k):
                raise AttributeError(k)
            setattr(c, k, v)
        return c

    def to_op(self, **labels):
        """The replay's config line."""
        op = {"op": "config"}
        op.update(labels)
        op.update({k: v for k, v in vars(self).items() if k != "lock"})
        op["lock"] = dict(vars(self.lock))
        return op


def device_term_config(**kw):
    return DeviceTermConfig(**kw)


def rate_of(eps_ppb):
    """The device's own rate (device ns per house ns, less 1, in ppb) for a lock's eps, rounded:
    the sign DEV-P4a's traces and an operator read (the KT USB output -135 ppm)."""
    den = E9 + eps_ppb
    return (2 * E9 * E9 + den) // (2 * den) - E9


def ratio_of(eps_in_ppb, eps_dev_ppb, max_ppm):
    """(1 + eps_in) / (1 + eps_dev) - 1 in ppb, rounded, clamped to +-max_ppm."""
    num, den = (E9 + eps_in_ppb) * E9, E9 + eps_dev_ppb
    lim = max_ppm * 1000
    return clamp((2 * num + den) // (2 * den) - E9, -lim, lim)


class DeviceTerm:
    IDLE, SETTLE = "idle", "settle"

    def __init__(self, cfg=None):
        self.cfg = (cfg or device_term_config()).copy()
        c = self.cfg
        self.lock = ClockLock(c.lock)
        self.rendering = False
        self.prev = None            # the last sample taken: (dev, mono)
        self.moved_at = None        # house time the settle counts from; None: not moved yet
        self.epoch = False          # the lock was fed since the term began
        self.beyond = 0             # fed samples in a row past relock_ns
        self.relocks = {"restart": 0, "step": 0}
        self.flat_ns = 0
        self.fed = 0
        # the stall rule
        self.stalled = False
        self.taken_prev = None
        self.discarded = 0          # pushed samples the flushes discarded before the sink took them
        self.wait_since = None
        self.flush_at = 0
        self.taken_at_flush = 0
        self.stalls = 0
        self.dropped = 0
        self.flushes = 0
        self.wait_samples = c.waiting_ns * c.rate_hz // E9
        self.resume_samples = c.resume_ns * c.rate_hz // E9

    # --- the device clock ------------------------------------------------------------------

    def start(self, mono):
        """The first buffer the sink rendered after it acquired its ring: reads may begin."""
        if self.rendering:
            return []
        self.rendering = True
        self.prev = None
        self.moved_at = None
        self.beyond = 0
        if not self.epoch:
            return []
        self.lock.relock(True)
        self.relocks["restart"] += 1
        return [{"event": "relock-device", "reason": "restart", "at": mono}]

    def stop(self, mono):
        """The sink released its ring: no read until the next start(); a stall ends with it."""
        self.rendering = False
        self.prev = None
        self.stalled = False
        self.wait_since = None
        self.taken_prev = None

    def _relock(self, mono, step_ns, events):
        self.lock.relock(True)
        self.relocks["step"] += 1
        events.append({"event": "relock-device", "reason": "step", "at": mono, "step_ns": step_ns})
        self.moved_at = mono
        self.beyond = 0

    def _clock(self, dev, mono, events):
        c = self.cfg
        prev, self.prev = self.prev, (dev, mono)
        if prev is None:
            return
        dd, dm = dev - prev[0], mono - prev[1]
        if dm <= 0 or dd * c.flat_den <= dm:   # flat: never fed
            self.flat_ns += max(dm, 0)
            return
        if self.moved_at is None:
            self.moved_at = mono
            return
        if mono - self.moved_at < c.settle_ns:
            return
        if self.lock.started:
            r = mono - self.lock.house_of(dev)
            if r > c.relock_ns or r < -c.relock_ns:
                self.beyond += 1
                if self.beyond >= c.relock_samples:
                    self._relock(mono, r, events)
                return
            self.beyond = 0
        self.lock.feed(dev, mono)
        self.epoch = True
        self.fed += 1
        if self.lock.envelope_step():
            self._relock(mono, self.lock.step_size, events)

    # --- the render ------------------------------------------------------------------------

    def _render(self, mono, pushed, taken, events):
        c = self.cfg
        prev, self.taken_prev = self.taken_prev, taken
        pending = pushed - taken - self.discarded
        flush = False
        if not self.stalled:
            if prev is None or taken > prev or pending <= self.wait_samples:
                self.wait_since = None
            elif self.wait_since is None:
                self.wait_since = mono
            elif mono - self.wait_since >= c.stall_ns:
                self.stalled = True
                self.stalls += 1
                events.append({"event": "device-stalled", "at": mono, "pending": pending})
                flush = True
        elif taken - self.taken_at_flush > self.resume_samples:
            self.stalled = False
            self.wait_since = None
            events.append({"event": "device-resumed", "at": mono, "dropped": self.dropped + pending})
            flush = True
        elif mono - self.flush_at >= c.probe_ns:
            # What the sink took since the last flush sat in a ring the stopped device never read.
            self.dropped += taken - self.taken_at_flush
            flush = True
        if flush:
            self.dropped += pending
            self.discarded += pending
            self.flush_at = mono
            self.taken_at_flush = taken
            self.flushes += 1
        return flush

    def sample(self, dev, mono, pushed=None, rendered=None):
        """One timer tick: (events, flush); flush: send FLUSH_START and FLUSH_STOP downstream now."""
        if not self.rendering:
            raise RuntimeError("the device clock is read only between start() and stop()")
        events = []
        self._clock(dev, mono, events)
        flush = False
        if pushed is not None and rendered is not None:
            flush = self._render(mono, pushed, rendered, events)
        self.lock.tick(mono)
        return events, flush

    # --- what the element reads ------------------------------------------------------------

    def device_ppb(self):
        """eps_dev, in ClockLock's sense; 0 until the lock has a rate."""
        return self.lock.ppb() if self.lock.rate_known else 0

    def ratio_ppb(self, eps_in_ppb=0):
        return ratio_of(eps_in_ppb, self.device_ppb(), self.cfg.ratio_max_ppm)

    def lock_state(self):
        if not self.rendering or self.moved_at is None:
            return self.IDLE
        if not self.lock.started:
            return self.SETTLE
        return self.lock.phase()

    def stats(self):
        return {"device_ppb": self.device_ppb(), "device_rate_ppb": rate_of(self.device_ppb()),
                "relocks_restart": self.relocks["restart"], "relocks_step": self.relocks["step"],
                "device_stalls": self.stalls, "dropped": self.dropped, "flushes": self.flushes,
                "flat_ns": self.flat_ns, "fed": self.fed}


class RenderLateness:
    """now - PTS(the sample at the device), from the device clock and each rendered buffer's write
    position (the base sink's next_sample after its render, less its samples)."""

    def __init__(self, rate_hz):
        self.rate = rate_hz
        self.map = []   # (write_pos, n, pts_ns), in write order

    def flush(self):
        self.map = []

    def rendered(self, write_pos, n, pts_ns, heard_pos=None):
        if self.map and write_pos < self.map[-1][0] + self.map[-1][1]:
            self.map = []   # the ring started again (a restart) or was written over
        if heard_pos is not None and write_pos + n <= heard_pos:
            return          # wholly behind the device: never heard
        self.map.append((write_pos, n, pts_ns))

    def at(self, now_ns, dev_ns):
        pos = dev_ns * self.rate // E9
        k = 0
        while k < len(self.map) and self.map[k][0] + self.map[k][1] <= pos:
            k += 1
        del self.map[:k]
        if self.map and self.map[0][0] <= pos:
            w, _, pts = self.map[0]
            return now_ns - (pts + (pos - w) * E9 // self.rate)
        return None


# --- replay --------------------------------------------------------------------------------------

def _line(obj):
    return json.dumps(obj, separators=(",", ":"))


def config_of(op):
    """A DeviceTermConfig from a config line."""
    c = device_term_config()
    for k, v in op.items():
        if k == "lock":
            for lk, lv in v.items():
                setattr(c.lock, lk, lv)
        elif k != "op" and hasattr(c, k):
            setattr(c, k, v)
    return c


def replay(lines):
    out, term = [], None
    for raw in lines:
        if not raw.strip():
            continue
        o = json.loads(raw)
        op = o.get("op")
        if op == "config":
            if term is not None:
                out.append(_line({"summary": term.stats()}))
            term = DeviceTerm(config_of(o))
            continue
        if term is None:
            term = DeviceTerm()
        if op == "start":
            out.extend(_line(e) for e in term.start(o["mono"]))
            continue
        if op == "stop":
            term.stop(o["mono"])
            continue
        if op == "sample":
            dev, mono, in_ppb = o["dev"], o["mono"], o.get("in_ppb", 0)
            pushed, rendered = o.get("pushed"), o.get("rendered")
        elif "clock_ns" in o:
            if o.get("next_sample", -1) < 0:
                continue    # nothing rendered yet: never read
            dev, mono, in_ppb, pushed, rendered = o["clock_ns"], o["mono_ns"], 0, None, None
            if not term.rendering:
                out.extend(_line(e) for e in term.start(mono))
        else:
            if o.get("event") == "restart":
                term.stop(o["mono_ns"])
            continue
        events, flush = term.sample(dev, mono, pushed, rendered)
        out.extend(_line(e) for e in events)
        out.append(_line({"mono": mono, "lock": term.lock_state(), "dev_ppb": term.device_ppb(),
                          "ratio_ppb": term.ratio_ppb(in_ppb), "stalled": int(term.stalled),
                          "flush": int(flush)}))
    if term is not None:
        out.append(_line({"summary": term.stats()}))
    return out


def main(argv):
    if len(argv) != 2:
        print("usage: asrc_device_ref.py seq.jsonl|-", file=sys.stderr)
        return 2
    with (sys.stdin if argv[1] == "-" else open(argv[1])) as f:
        for line in replay(f):
            print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
