"""Retained-backlog policy for a clock-paced consumer leg (pure logic, no GStreamer).

THE FAILURE THIS EXISTS FOR — the time-sync contract's latency RATCHET.

Under the contract every presentation consumer runs `sync=true`, so its sink
drains at exactly media rate. That makes backlog one-way. Any downstream hiccup
(a decoder stall, a compositor hitch, a CMA allocation) parks data in the leg's
leaky queues, and a media-rate sink never gives it back: the retained latency
that hiccup created is still there an hour later, and the next hiccup adds to
it. The legacy `sync=false` sink had no such problem — it presented on arrival,
so it gulped any backlog at max speed and drained itself, which is the (now
falsified) assumption the video leg's queue sizing was written against.

Field, 10.9.1.42 (Pi 400, 2026-08-13/14): retained latency climbed over ~16 h
until buffers reached `videoconvert`/`waylandsink` late enough for QoS to drop
almost all of them — decoder still running at 50 fps (codec IRQ ~100/s), glass
at 2.5 fps (`vc4 crtc` IRQ 2.2/s). A live `ts-offset` bump of +1 s restored
60 fps instantly and reverting it put the box straight back to 2.5 fps, which is
what proves the fault is retained SCHEDULE, not throughput.

WHAT THIS DECIDES, and what it deliberately does not. This class owns only the
question "is the leg holding more latency than the route's playout budget D, and
is it time to give it back?" — sustained-excess detection plus rate limiting.
The measuring and the actual dropping live in `gst-pipeline-runner.py`
(`_start_backlog_shedder`), which is where the pads are. Keeping the decision
here makes it testable without a pipeline, the same split as `render_lag.py`.

THE ARITHMETIC. The runner feeds one LATENESS sample per buffer at the shed
point: `lateness = now_running_time - (buffer_running_time + ts_offset)`, i.e.
how far past its scheduled playout slot the buffer is. `ts_offset` IS the
route's playout offset D, so lateness is the excess over budget directly:

    retained pipeline latency  =  lateness + D

Healthy is NEGATIVE (a buffer reaches the shed point before its slot, and the
sink waits); positive is retained backlog beyond D and never recovers on its own.

WHY A FLOOR, NOT AN AVERAGE. Lateness spikes during a stall and relaxes; what
matters is the level it relaxes back TO, because that is buffering the pipeline
will never return. So the trigger is "EVERY sample for `hold_ms` was above
tolerance" — one sample at or below tolerance resets the streak. That is the
per-interval minimum the ratchet reproduction measures, expressed as a rule.

OSCILLATION IS IMPOSSIBLE BY CONSTRUCTION. A shed always ends with lateness at
or below zero (the runner drops until it is), so the streak has to be rebuilt
from scratch: `tolerance_ms` of fresh retention, sustained `hold_ms`, and no
sooner than `cooldown_ms` after the last shed finished. The worst case is one
shed per cooldown, which the events make countable.
"""

# Defaults. Chosen against the video leg's own numbers: the ES queue holds 1 s
# and the jitter queue `bufferMs` (200 ms default), so 250 ms of retention over
# budget is well clear of one absorbed IDR burst (~200 ms of stream time on a
# Pi 4 at 8 Mbps) yet far below `waylandsink max-lateness=1000000000`, the cliff
# past which the sink drops nearly every frame.
DEFAULT_TOLERANCE_MS = 250.0
# Sustained means sustained: 5 s is long enough that a burst being absorbed and
# handed back cannot trip it, short enough that a genuine step (which never
# comes back) is answered in seconds rather than after it has cost frames.
DEFAULT_HOLD_MS = 5_000.0
# One shed per minute per leg, worst case. A shed returns ALL of the excess, so
# frequency buys nothing — and each one costs the video leg the frames up to the
# next IRAP, which the operator sees.
DEFAULT_COOLDOWN_MS = 60_000.0
# Above this, the reading is NOT a backlog. A real retained backlog is bounded
# by the leg's queues (1 s ES + up to 5 s jitter); a sample of tens of seconds
# means the buffer timeline and the pipeline clock are not the same timeline at
# all (an unstamped producer, a segment this code did not expect), and shedding
# on it would drop the entire stream for ever chasing a target it can never
# reach. So it is reported, never acted on. 10 s is `MAX_PLAYOUT_OFFSET_MS`.
DEFAULT_SANITY_MS = 10_000.0


class BacklogShedPolicy:
    """Decides WHEN a clock-paced leg must hand its retained backlog back.

    `observe(lateness_ms, now_ms)` takes one sample per buffer and returns:

        None            nothing to do
        "shed"          start shedding now (returned once per episode)
        "implausible"   the sample is past `sanity_ms` — reported once per
                        episode so the runner can log it; never a shed

    `now_ms` is any monotonic millisecond count; the runner passes the pipeline
    clock's running time, so the policy and the measurement share one time base.
    """

    def __init__(self, tolerance_ms=DEFAULT_TOLERANCE_MS, hold_ms=DEFAULT_HOLD_MS,
                 cooldown_ms=DEFAULT_COOLDOWN_MS, sanity_ms=DEFAULT_SANITY_MS):
        self.tolerance_ms = float(tolerance_ms)
        self.hold_ms = float(hold_ms)
        self.cooldown_ms = float(cooldown_ms)
        self.sanity_ms = float(sanity_ms)
        self.sheds = 0
        self._above_since = None      # start of the current unbroken excess run
        self._last_shed_end = None    # cooldown anchor; None = never shed
        self._implausible = False     # latched so it is reported once, not per buffer

    def reset(self):
        """Drop the streak (not the counters): a flush/re-anchor makes the
        samples either side of it incomparable."""
        self._above_since = None
        self._implausible = False

    def observe(self, lateness_ms, now_ms):
        if lateness_ms is None or lateness_ms != lateness_ms:   # NaN
            return None
        if abs(lateness_ms) > self.sanity_ms:
            # Not a backlog — see DEFAULT_SANITY_MS. The streak is dropped too:
            # a timeline mismatch must never accumulate toward a shed.
            self._above_since = None
            if self._implausible:
                return None
            self._implausible = True
            return "implausible"
        self._implausible = False
        if lateness_ms <= self.tolerance_ms:
            self._above_since = None
            return None
        if self._above_since is None:
            self._above_since = now_ms
            return None
        if now_ms - self._above_since < self.hold_ms:
            return None
        # Sustained excess. The cooldown gate does NOT reset the streak: a leg
        # that is still over budget when the cooldown expires sheds immediately,
        # rather than paying the hold window again.
        if self._last_shed_end is not None and now_ms - self._last_shed_end < self.cooldown_ms:
            return None
        return "shed"

    def shed_finished(self, now_ms):
        """The runner reached its target (or gave up). Arms the cooldown and
        forces the streak to be rebuilt from scratch."""
        self.sheds += 1
        self._last_shed_end = now_ms
        self._above_since = None
