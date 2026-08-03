# ADR-0006: Hardware PipeWire sinks are held at unity gain

Gain staging lives in software. Hardware PipeWire sinks are forced to unity
(100% on every channel, raw `PA_VOLUME_NORM` = 65536) whenever the `audio-sink`
device provider polls, and any drift is corrected on the next poll.

## Why

There were two gain stages in series and only one of them was visible. Modules
attenuate on their own `MR_PW_*` remap-sink or in GStreamer, which is what the
UI volume control drives. The underlying hardware sink carried a second,
invisible multiplier: WirePlumber restores whatever level a device was last
left at, and a fresh USB interface commonly comes up at 40% / -23.9 dB. A
module showing 100% was really outputting -23.9 dB, with nothing in the UI to
explain it — a broadcast system must not silently attenuate.

Correcting on detection (rather than once at boot) covers hot-plug, engine
restarts, and anything that changes the level behind our back (`alsamixer`, a
desktop mixer, a WirePlumber restore after profile switch).

## Consequences

- Device volume is no longer adjustable outside Media Router — an operator
  turning a sink down with `pactl` or `alsamixer` will see it snap back within
  one poll. That is the intent: one authoritative gain stage.
- `MR_PW_*` devices are exempt (they never reach the normalizer — `listDevices`
  filters them), so per-module software volume is untouched.
- Scoped to sinks. Hardware sources are left alone for now; input gain on a
  capture device is often a real analogue trim rather than a stale restore.
- Implementation: `SinkVolumeNormalizer`, invoked from
  `registerPipeWireDeviceProvider` for `direction: 'sink'`.
