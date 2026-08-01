"""Render keep-up detector for a video sink (pure logic, no GStreamer).

The runner counts buffers reaching the sink pad and, once per window, feeds
this monitor the count plus the framerate the stream *declares* in its
negotiated caps. The monitor decides — with hysteresis — whether the pipeline
is failing to keep up (frames are being shed upstream by the leaky queues /
QoS) and reports state TRANSITIONS only:

    tick(...) -> None | ("lag", achieved_fps, expected_fps)
                      | ("recovered", achieved_fps, expected_fps)

Rules:
- `expected_fps` unknown (<= 0, e.g. caps without VUI timing) → nothing to
  judge against; both streaks reset, no events.
- Zero-frame windows BEFORE the first rendered frame are startup, not lag —
  the pipeline may still be prerolling and a genuinely dead source is the
  stall watchdog's condition. They reset the streaks.
- Zero-frame windows AFTER frames have flowed count as lag (achieved 0):
  a starving sink behind a still-flowing source is the worst lag there is —
  a decoder that can't keep up sheds so much upstream that whole windows
  come up empty, and treating those as "stall" would mask exactly the
  condition this monitor exists to report.
- Lag latches after `trip_windows` consecutive windows below
  `lag_ratio * expected`; recovery clears it after `trip_windows` consecutive
  windows at or above `recover_ratio * expected`. The gap between the two
  ratios is the hysteresis band that stops flapping around the threshold.
- A change in `expected_fps` (mid-stream format switch) resets the streaks —
  windows straddling a switch would judge the old rate against the new caps.
"""


class RenderLagMonitor:
    def __init__(self, lag_ratio=0.85, recover_ratio=0.95, trip_windows=3):
        self.lag_ratio = lag_ratio
        self.recover_ratio = recover_ratio
        self.trip_windows = trip_windows
        self.lagging = False
        self._below = 0
        self._above = 0
        self._last_expected = None
        self._started = False   # True once any window has rendered frames

    def reset(self):
        self._below = 0
        self._above = 0
        self._last_expected = None
        # `lagging` and `_started` survive reset() on purpose: a caps switch
        # mid-lag should not synthesize a "recovered" event (recovery must be
        # measured), and it doesn't un-happen that frames have flowed.

    def tick(self, frames, window_s, expected_fps):
        if window_s <= 0:
            return None
        if expected_fps is None or expected_fps <= 0:
            self._below = 0
            self._above = 0
            self._last_expected = None
            return None
        if frames <= 0 and not self._started:
            # Startup / preroll — nothing rendered yet, nothing to judge.
            self._below = 0
            self._above = 0
            self._last_expected = expected_fps
            return None
        if frames > 0:
            self._started = True
        if self._last_expected is not None and expected_fps != self._last_expected:
            self._below = 0
            self._above = 0
        self._last_expected = expected_fps

        achieved = frames / window_s
        if achieved < self.lag_ratio * expected_fps:
            self._below += 1
            self._above = 0
            if not self.lagging and self._below >= self.trip_windows:
                self.lagging = True
                return ("lag", achieved, expected_fps)
        elif achieved >= self.recover_ratio * expected_fps:
            self._above += 1
            self._below = 0
            if self.lagging and self._above >= self.trip_windows:
                self.lagging = False
                return ("recovered", achieved, expected_fps)
        else:
            # Inside the hysteresis band: neither streak advances.
            self._below = 0
            self._above = 0
        return None
