# ADR-0014: 302M stream width — ≤ 8 per stream, declared by the producer, wide capture is whole-device + matrix

Three decisions, locked together on 2026-09-05 when an X32 (KT-USB, 48 capture
channels) showed up on the 302M input as inputs 1–2 only.

1. **A 302M stream carries 2/4/6/8 channels, and that is where the width
   stops.** `build302mEncodeBranch({ channels })` snaps every request onto that
   set (`normalize302mChannels`). More channels are MORE PRODUCER MODULES — an
   X32's 32 inputs are four `audio-input-302m` instances at 8 channels each,
   first channel 1 / 9 / 17 / 25 — never a wider stream, a side channel, or a
   second codec.
2. **The producer declares its wire width; the engine stays generic.**
   `PluginModule.getBusStreamChannels(portId)` is the only source of a bus
   stream's channel count. `MediaRouter.getModuleBusSources` relays it as
   `sourceChannels`; consumers default to stereo when nothing is declared. A
   producer's `channels` CONFIG is never read for this.
3. **Multichannel capture is `pipewiresrc` on the WHOLE device, unpositioned,
   then an `audioconvert mix-matrix` range pick** — not `pulsesrc`, not a
   stream sized to the range.

## Why

**Ceiling.** SMPTE 302M defines 2/4/6/8-channel layouts and nothing else;
`avenc_s302m` on the fleet's gst 1.28.2 advertises exactly `channels: { 2, 4,
6, 8 }`. Any "32-channel 302M" would be a private format that no other 302M
consumer (or `avdec_s302m`) could decode, and it would break the property that
a 302M stream is valid TS for SRT/RIST transport.

**Declared width.** The first cut read the producer module's `channels`
setting from engine core. That is wrong in kind, not just in a case: a config
field says what a module was ASKED to do, the wire is what it DID. `aes67-input`
accepts `channels` 1–8 for the received stream yet encodes stereo 302M and
downmixes — reading its setting would have handed an 8-column matrix to a
2-channel stream and audioconvert rejects the dimensions, taking the consumer
pipeline down. It also put a 302M assumption into `packages/engine`
([[0007]]: `packages/` holds generic systems only). The declared-width hook is
generic ("how wide is this bus port's audio") and the 302M knowledge stays in
`audio-302m-core` and the producer.

**Whole-device capture.** Measured against the X32 on PipeWire 1.6.3:
- pipewire-pulse cannot create an 8-channel record stream at all ("Failed to
  create stream: Invalid argument") and links a 4-channel one to AUX0/AUX1
  only — `pulsesrc` is a dead end past stereo.
- PipeWire links ports by channel POSITION. A stream of ≤ 8 channels is given
  default positions (FL, FR, RL, …) that never match a multichannel card's
  AUX0..AUXn names, so exactly two ports link. A stream requesting the card's
  full width with `channel-mask=0x0` stays unpositioned and is linked
  port-for-port in index order — 48 of 48 links observed.
So the only reliable way to reach channel 9 is to take all of them and select
in the pipeline. The matrix is a small per-buffer multiply; the win is
determinism.

## Consequences

- Width is a property of the producer INSTANCE, so the manager's channel-map
  editor (which reads the producer's `channels` setting) and the fan-in matrix
  (which reads the declared width) agree only while a producer's declared
  width equals `normalize302mChannels(channels)`. `audio-input-302m` keeps
  that invariant; a producer that cannot must not expose a `channels` setting
  under that name.
- The engine learns a device's width through the Pulse compatibility layer
  (`pactl`), which caps at 32 channels; channels 33+ of a wider card are not
  selectable until device enumeration moves off `pactl`.
- A card of ≤ 8 channels whose ports carry AUX names still links two channels
  (position matching), the same as before. Cards that name their ports FL/FR
  etc. are unaffected.
- `pipewiresrc` stamps PTS from pipeline running time, like `pulsesrc` did, so
  the "capture time is the timeline" contract of the 302M input ([[0005]])
  holds; `srcBufferMs` now maps to a `node.latency` request rather than a
  Pulse ring size.

## Addendum (2026-09-05, same day): output placement

`audio-output-302m` gained the mirror settings — `channels` is the mix width
(1–8) and a new `firstChannel` says where on the device it lands. Any range
other than the default (mono/stereo from channel 1) is spread onto the
device's FULL width with an `audioconvert mix-matrix` (every other column
silent) and handed to the sink as an unpositioned `channel-mask=0x0` stream,
for the same reason as decision 3: only an unpositioned full-width stream is
linked port-for-port. Measured on the X32's KT-USB sink: a 32-channel
unpositioned stream into `pulsesink` links `playback_AUX0..31` in order.

Two deliberate differences from the capture side:

- **The sink element stays `pulsesink`.** pipewire-pulse accepts the 32-channel
  unpositioned playback stream (it refused the 8-channel record stream), so the
  ADR-0005 presentation leg — `sync=true provide-clock=false slave-method=skew
  max-lateness=-1 buffer-time=100000 ts-offset=D+trim`, backlog shedder on the
  sink pad — is untouched; placement only adds a matrix and caps upstream.
  Bonus measured on the same sink: `pulsesink` keeps an unpositioned stream
  unpositioned at ANY width (an 8-channel `channel-mask=0x0` stream linked
  `playback_AUX0..7` in order), where `pipewiresink` gives ≤ 8 channels default
  positions and links two. So the ≤ 8-channel AUX-card limitation in the
  consequences above is a capture-side (`pipewiresrc`) limitation only.
- **The default range keeps the legacy positioned stream** (no matrix, no wide
  caps), so every existing profile's pipeline string is byte-identical and the
  contract kill-switch still reproduces the old string exactly. On a stereo
  DAC a positioned FL/FR stream is also simply correct.

`plugins/audio-output-302m/engine/outputPlacement.ts` holds the rule; the same
helper is the obvious fit for `audio-decoder` (the other `pulsesink`
presentation leg) if it ever needs placement.

## References

- `plugins/audio-302m-core/engine/audio302mHelpers.ts` — `build302mEncodeBranch`,
  `normalize302mChannels`, and the `sourceChannels` matrix sizing in
  `buildAudioMixInput`.
- `plugins/audio-input-302m/engine/AudioInput302mModule.ts` — the capture shape
  and `getBusStreamChannels`; its class comment carries the measurements.
- `plugins/audio-output-302m/engine/outputPlacement.ts` — the playback
  placement (addendum above).
- `packages/engine/src/plugins/PluginModule.ts` — `getBusStreamChannels`;
  `packages/engine/src/routing/MediaRouter.ts` — `getModuleBusSources`.
- `docs/TodoNotes.md` — "302M input captured only X32 inputs 1–2 of 32" (2026-09-05).
