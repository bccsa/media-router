# ADR-0016: Subtitles travel as KLV-wrapped WebVTT cues; renderers draw via a property, not the text pad

A subtitle stream on the bus is a single-program MPEG-TS whose one elementary
stream carries **one WebVTT cue block per PES, wrapped in a SMPTE 336M-style
KLV triplet** (`meta/x-klv,parsed=true` — stream_type 0x06 + KLVA
registration, which `mpegtsmux` writes and `tsdemux` exposes natively). Cue
times are **relative to the carrying PES** (amended 2026-09-16, below). Producers and consumers
speak it through `plugins/subtitle-core` (TypeScript and python twins,
byte-pinned to each other); the plugin's own `py/subtitle_bridge.py` does the
per-cue work on both ends inside the pipeline runner, installed through the
generic `PipelineDescription.runnerHooks` seam so the engine stays
subtitle-agnostic (ADR-0002). Renderers (video-player, transcoder) share one set
of overlay controls and draw with `textoverlay`, but the bridge sets the
element's **`text` property from a probe on its video sink pad** — the text
pad is never linked.

## Considered options

- **hls-pipe's `"VTT "` private PES** (stream_type 0x06 + registration
  `"VTT "`, what the HLS player already muxes) — rejected: `tsdemux` creates
  no pad for a private stream with an unknown registration, so no GStreamer
  consumer on the fleet could ever see it. hls-pipe should migrate to this
  carrier.
- **`meta/x-id3`** — works end to end but adds ID3 framing for no gain over
  KLV, which the fleet already carries (name carousel, ADR mpegts-dynamic-
  streams D2).
- **DVB subtitles** (`teletextdec ! textrender ! dvbsubenc`) — the only carrier
  third-party receivers (VLC, STBs) render; bitmap, position baked at encode.
  Kept as a later *output mode* for streams leaving the fleet, not the
  in-fleet carrier.
- **A non-TS `text/subtitle` bus stream** — rejected: the bus carries TS and
  PipeWire audio only; a third transport family for a few cues a second is
  not worth it.
- **Teletext pass-through** (`application/x-teletext` mux/demux natively) —
  fine as a bonus for the muxer, but gives no per-page outputs and pushes the
  page choice to every consumer.
- **textoverlay's text pad** for rendering — rejected after the 2026-09-09
  spike: a text buffer shows only while `[pts, pts+duration)` overlaps the
  video, a buffer with no duration flashes for one frame, and the pad blocks
  while a buffer is pending, so a live cue stream either flickers, holds
  stale text, or delays the next cue. The property set from the video path is
  frame-accurate against the stamped timeline and never blocks.

## Consequences

- Subtitle outputs are ordinary `muxed/mpegts` ports (`streamInfo.media:
  'subtitle'`), so they route through SRT/RIST outputs and the mpegts-muxer
  unchanged, and any consumer with a `subtitles-in` port renders them.
- Cue timing is absolute house time: a cue shows when the video frame with
  that stamped PTS is composed, independent of playout offset D and of how
  many hops the cue took. Where a consumer's frames are not stamp-aligned the
  bridge falls back to "show on arrival".
- Cue END times matter: the producer stamps `[now, now + hold)` and sends a
  zero-length CLEAR cue when the source erases; a renderer clears at whichever
  comes first. `holdMs` is the safety net for sources that never clear.
- The subtitle PID range is `0x180 + N` (subtitle-core `subtitleStreamPid`),
  between audio (0x140…) and the metadata carousel (0x1f0); the splitter now
  labels DVB teletext / DVB-sub / KLVA private PIDs by their descriptors.
- The renderer's overlay element sits AFTER `videoconvert`; on hardware-decode
  paths that means the frame leaves the zero-copy path while a subtitle
  source is wired (no cost when none is).
- Third-party visibility (VLC) of fleet subtitle streams is nil by design;
  DVB-sub output is the answer when it is needed.

References: `docs/subtitles-teletext-vtt-plan.md` (research + spike),
`plugins/subtitle-core/` (incl. `py/subtitle_bridge.py`), the runner's `runnerHooks` seam,
`plugins/teletext-subtitles/`.

## Amendment 2026-09-16 — cue times are relative to the PES, not house time

The first cut wrote the cue's absolute house-clock start/end into the WebVTT
block and stamped the PES with the cue start. Field test .103 → muxer → SRT →
.108 showed why that cannot work beyond one engine: the receiving box has its
own monotonic house clock, so absolute times never matched a frame and no cue
was drawn; and a PES PTS that jumps back to a cue's start on every re-send
made every stamper on the route treat the KLV PID as a clock reset and
re-anchor the whole program (video dropped to 0.5 fps).

Now: the PES PTS is the **send time** (monotonic), the block carries
`start --> end` **relative to that PES** (a running cue is `0 --> remaining`,
recomputed on each 2 s re-send), and the consumer anchors the span on the cue
PES's own frame time (its PTS when stamp-aligned, else its arrival). The PES
travels in the same TS as the video and is re-stamped by the same stamper on
every hop, so "relative to this PES" stays true on any box. Wire format
(KLV key, WebVTT block) is unchanged; only the meaning of the times.

And the stamper side, same day: `mrts::TimelineStamper` (native `mrtsstamp`,
`mr-tssplit`, `mr-bus-fanout`) and its python twin only let a PES whose
`stream_id` is video (0xE0–0xEF) or audio (0xC0–0xDF), or the PCR-carrying
PID, anchor, latch-repair, trip the watch, define a conditioner step or feed
the drift servo (`timing_pes`). A private PID still FOLLOWS the program's
conditioner correction (ADR-0018) — it is on the program's timeline, it just
never sets it. A private-data PID (0xBD: KLV cues, teletext, DVB
subtitles) rides the media's anchor untouched; an egress with nothing but
private PES and no PCR never anchors and stamps every buffer at arrival.

## Amendment 2026-10-07 — the HLS player speaks the carrier

hls-pipe's `"VTT "` private PES (the first considered option above) is retired
from the fleet. hls-pipe gained a carrier seam (`ExtractorOptions.subtitleCarrier`:
PES payload per cue, PMT stream_type + descriptors, PID base, re-send cadence)
and the hls-player plugin passes subtitle-core's KLV encoder through it
(`plugins/hls-player/engine/klvSubtitleCarrier.ts`): stream_type 0x06 + KLVA
registration — byte for byte what mpegtsmux writes — plus hls-pipe's ISO 639
language descriptor, PIDs from 0x180, one KLV triplet per PES with the block
relative to the carrying PES, re-sent every 2 s while live, text Pango-escaped.
hls-pipe's library default stays the `"VTT "` carrier (standalone CLI users).

Timing: hls-pipe now writes each cue PES at the cue's START position in the
paced stream and holds the cues the subtitle playlist delivered early (it is
fetched independently of video, so a VOD track arrives all at once). Every hop
re-stamps a private-only PES at arrival (splitter leg, muxer sparse route) and
the renderer keeps one cue, so a cue sent early would have shown early or been
overwritten before it showed. A past-due cue goes out at once with its
remaining span; an ended one is dropped. Every subtitle PID is listed in every
PMT from the first batch on, so the program's stream list never flaps (a PMT
change tears consumer pads down).

The splitter labels a KLVA PID that also carries a language descriptor
`Subtitle <lang> (webvtt, PID …)` — mpegtsmux never writes a language on KLV,
so the fleet's own KLV PIDs stay `Metadata (klv)`. Consequence: an HLS subtitle
language is wired exactly like a teletext page — splitter `pid-0x180` →
`subtitles-in` (burn-in) or → a muxer input (mux on).
