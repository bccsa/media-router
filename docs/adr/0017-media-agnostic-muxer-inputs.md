# ADR-0017: Muxer inputs are media-agnostic; every stream routes by class into its input's PID block

The MPEG-TS muxer has **N generic inputs** (`inputs[]`, ports `input-N`), not
separate video and audio ports. Any input takes any `muxed/mpegts` source and
**every** elementary stream `tsdemux` exposes from it is routed by its **route
class** — `video`, `audio`, `klv` (`meta/x-klv`, the WebVTT subtitle carrier
of ADR-0016), `subtitle` (DVB subtitling / teletext) — to a deterministic PID
inside the input's block (`muxInputClassPid(muxInputBasePid(inputIndex),
class)`, plugin-local `engine/muxPids.ts`: 0x100 + 8·input, video +0 /
audio +1 / klv +2 / subtitle +3; 0x1f0 stays reserved — the metadata PID older
muxers' name carousel used, still dropped downstream). Routing
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
- A generic input owns an **8-PID block**: `pid` (config, one field per
  input) is its video PID and the other classes follow at fixed offsets
  (audio +1, klv +2, subtitle +3 — `muxInputClassPid`). Blank = automatic
  `muxInputBasePid(index)` = 0x100 + 8·index, and the module writes that
  value back into the field (`emitConfigUpdate`) so the operator sees the PID
  in use; `isLiveChange` recognises the seed so it never restarts the muxer.
  Blocks are laid out with every configured input, wired or not, and checked:
  two slots on one PID, or a block touching the carousel (0x1f0) or PMT
  (0x1000) PID, is a build error that stops the muxer with a message naming
  both streams — never a second `sink_<pid>` request that mpegtsmux fails on
  the wire. Config validation cannot reject the patch (the manager only checks
  the JSON schema at module creation), so the health error IS the guard.
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
