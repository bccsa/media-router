# ADR-0017: Muxer inputs are media-agnostic; every stream routes by class onto its input's PID

*Amended 2026-09-18: one PID per input, no PID blocks — see the last consequence.*

The MPEG-TS muxer has **N generic inputs** (`inputs[]`, ports `input-N`), not
separate video and audio ports. Any input takes any `muxed/mpegts` source and
**every** elementary stream `tsdemux` exposes from it is routed by its **route
class** — `video`, `audio`, `klv` (`meta/x-klv`, the WebVTT subtitle carrier
of ADR-0016), `subtitle` (DVB subtitling / teletext) — to a deterministic PID:
the input's own `pid` for the stream it carries (plugin-local
`engine/muxPids.ts`; a multi-stream source's further classes on the next free
PIDs above it; 0x1f0 stays reserved — the metadata PID older muxers' name
carousel used, still dropped downstream). Routing
is the **plugin's own runner hook** (`plugins/mpegts-muxer/py/mux_routing.py`,
installed through the engine's generic `PipelineDescription.runnerHooks`
seam, ADR-0016): at pad-added time the first pad of each class goes to its
route, and every other pad — a second stream of a class, an unknown private
stream, the upstream name carousel — is sunk into a `fakesink` so the demuxer
keeps flowing. Because the builder no longer knows which input carries video,
the hook also picks the **PCR** (`prog-map` `PCR_1` → first video pad linked,
else first audio), so PCR always rides a media stream, never a data stream.
The engine learns nothing of any of this (ADR-0002): its `PadLinkRule`
contract is unchanged, and a third-party muxer could be built the same way.

**Why.** The video/audio port model refused everything else: a KLV-only
subtitle TS wired to an audio port had no pad the `media: 'audio'` rule would
link, `tsdemux` returned NOT_LINKED and the muxer restart-looped, taking the
SRT output on its bus channel down with it (.103, 2026-09-15). Subtitles have
to ride a muxed program to reach a remote site, so the muxer must carry them.

## Consequences

- Configs from before this (`videoStreams` / `audioStreams`, ports `video-N`
  / `audio-N`) are read unchanged and **legacy keys win** over `inputs`: their
  ports keep their ids (wiring survives the upgrade) and their A/V PIDs keep
  the old per-kind connected-ordinal scheme (downstream splitter ports keep
  their identity). A legacy port routes its own kind plus klv/subtitle, never
  the other A/V kind. Switching such a module to generic inputs is a
  deliberate re-create; the module reports the mode in its status.
- The engine's `PadLinkRule.media: 'video' | 'audio'` (positional
  `branches`) is untouched. The muxer does not use it: its hook config is one
  `MuxRoutingInput` per source (`demux`, `linkTo`, `routes` per class with
  `padName` / `branch` / `padOffsetNs` / `parser` / `sparse`, `ignorePids`,
  `pcr`), types in `muxPids.ts`, pinned end to end by `py/mux_routing_test.py`
  (a real KLV TS through tsdemux → hook → mpegtsmux). *2026-09-16 revision:*
  the first cut put this routing, the PCR pin and the sparse restamp into the
  engine runner as a `media: 'any'` rule; that was moved here the same day —
  the plugin architecture's rule is no domain code in the runner.
- **The in-band name carousel (plan D2, PID 0x1f0) is retired** (2026-09-16):
  nothing on the fleet read it (the ts-splitter labels from the PMT; the
  mpegts-demuxer that read it is gone) and every splitter behind a muxer
  listed it as a stray port and counted it as a stream. Stream identity
  travels the official way only — the ISO 639 language descriptor in the PMT,
  written by mpegtsmux from the input's `language` (applied to every
  non-video class; mpegtsmux writes it for audio today — carrying it on KLV /
  teletext streams needs an mpegtsmux patch). An input's `name` is a UI
  label on the pin, nothing more. Muxers still ignore an upstream 0x1f0 from
  older builds.
- **One PID per generic input** (2026-09-18, replacing the 8-PID block of
  the first cut): `pid` (config, one field per input) is the output PID of
  the stream the input carries — what a downstream splitter shows. Blank =
  the next free automatic PID (`nextFreeInputPid`: from 0x100 in steps of 8,
  skipping every PID another input has), written back into the field
  (`emitConfigUpdate`) so the operator sees it and later inputs never move
  it; `isLiveChange` recognises the seed (a pure function of the previous
  list) so it never restarts the muxer. Two inputs on one PID, or a reserved
  PID (0x1000 PMT, 0x1f0 carousel), is a build error naming both inputs —
  never a second `sink_<pid>` request that mpegtsmux fails on the wire; the
  health error IS the guard, since the manager only checks the JSON schema at
  module creation. The first cut's block model (video +0, audio +1, klv +2,
  subtitle +3) was dropped because a subtitle-only input set to 264 came out
  on 266 — the field said one thing, the wire another. When a source carries
  several streams (a transcoder's video + cue stream, a whole TS) the
  **hook** puts the highest-priority class (video, audio, klv, subtitle) on
  the input's PID and each further class on the next free PID above it,
  deciding from the source **PMT** (tsdemux posts every section on the bus;
  `sync-message::element` on the demuxer's own streaming thread precedes its
  pad-added) so the outcome never depends on which pad appears first; a class
  keeps its PID for the run, `prog-map` gains the spilled entries before the
  pad is requested, and the module learns the placement on `mux:routed`
  plugin events (the per-input "PIDs" status rows). The PMT is read with
  `gstreamer-mpegts-1.0` in both hook forms; python cannot see raw
  descriptor bytes, so the classifier takes (tag, registration id /
  extension tag) — the native form derives the same pair from the bytes.
  Spill PIDs are not part of the build-time check (the builder does not know
  the source's stream set); the hook keeps them collision-free at link time
  from one `taken` set — every input's own PID from install, every PID it
  hands out, the reserved ones — under a lock, and a source with no PID
  left above its input's is reported and sunk, never left unlinked. PCR is
  seeded on the first input's PID and re-pointed by the hook at the first
  video (else audio) pad it links; a muxer carrying no media stream at all
  (subtitles only) therefore clocks off its data pad — mpegtsmux's own
  default when no PCR pad matches, and what the first cut did too. The set
  PID was never deployed to the fleet before this change, so no migration:
  existing seeded values stay exactly as written.
- **Input ports are keyed, not positional** (2026-09-18): a generic input's
  port id is `input-<key>`, `key` a stable integer the module seeds into the
  entry (its index if free, else one past the highest key — existing configs
  therefore keep `input-0`, `input-1`, …). Removing an entry from `inputs`
  no longer renames the ports after it, so every connection stays on its own
  input; the removed input's port vanishes and the ENGINE retires the stored
  connections on any vanished dynamic port (`ModuleLifecycle.
  onDynamicPortsRemoved` → `remove /connections/<id>` to the manager), so the
  edge leaves SQLite and the UI instead of dangling — on the operator's
  patch itself for a running module (`EnginePatchRouter` re-resolves ports
  after every settings apply), else at the next start. Labels stay
  positional (`Input 1`, `Input 2`…). Before this, removing input 1 of three slid the
  second and third links up one port and left the third edge pointing at a
  port that no longer existed.
- The `klv` and `subtitle` routes are **sparse** (`MuxRoute.sparse`): the
  hook restamps every buffer on the mux pad to the pipeline running time
  and sends a GAP event every 500 ms, placed 1 s ahead of that position.
  Without it `mpegtsmux` (a GstAggregator) held the video for `latency` +
  `min-upstream-latency` = 2.4 s whenever the cue pad was idle and then burst
  it (measured .103 2026-09-16; a clean 240 ms per 250 ms with the cue input
  off, the same with the keepalive on). The branch's own timestamps are not
  used: tsdemux hands a one-PES-per-2-s private stream over mostly without
  PTS, and unaligned when it has one; a cue's timing is relative to its own
  arrival (ADR-0016), so the PES leaves the mux beside the video of the same
  instant. GAPs placed at "now − latency" were consumed at once and paced the
  video in 500 ms steps — the position is the running time, not minus the
  aggregator's budget.
- `data` (anything tsdemux exposes that is none of the four classes) is never
  routed: `mpegtsmux` has no sink caps for it and a failed request-pad link is
  a pipeline error.
