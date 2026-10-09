# ADR-0016: Subtitles travel as KLV-wrapped WebVTT cues; renderers draw via a property, not the text pad

A subtitle stream on the bus is a single-program MPEG-TS whose one elementary
stream carries **one WebVTT cue block per PES, wrapped in a SMPTE 336M-style
KLV triplet** (`meta/x-klv,parsed=true` — stream_type 0x06 + KLVA
registration, which `mpegtsmux` writes and `tsdemux` exposes natively). Cue
times are **relative to the carrying PES**, whose PTS is the cue's content time (amended 2026-09-16 and 2026-10-09, below). Producers and consumers
speak it through `plugins/subtitle-core` (cue codec twins `engine/subtitleCue.ts`
↔ `py/subtitle_klv.py`, byte-pinned); the plugin's own `py/subtitle_bridge.py` does the
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
Superseded 2026-10-09 (below): the PES PTS is the cue's content time and the
consumer anchors on the bus chunk stamp; the relative-time wire format stands.

And the stamper side, same day: `mrts::TimelineStamper` (native `mrtsstamp`,
`mr-tssplit`, `mr-bus-fanout`) and its python twin only let a PES whose
`stream_id` is video (0xE0–0xEF) or audio (0xC0–0xDF), or the PCR-carrying
PID, anchor, latch-repair, trip the watch, define a conditioner step or feed
the drift servo (`timing_pes`). A private PID still FOLLOWS the program's
conditioner correction (ADR-0018) — it is on the program's timeline, it just
never sets it. A private-data PID (0xBD: KLV cues, teletext, DVB
subtitles) rides the media's anchor untouched; an egress with nothing but
private PES and no PCR never anchors and stamps every buffer at arrival.

## Amendment 2026-10-09 — content-timed cues

Burned-in teletext on NO-OCC-Gate01 ran 1–6 s late. Measured causes: (1) video
PES lead the PCR by 0.9–1.5 s, teletext by 52 ms, so a frame's teletext arrives
~1.05 s after it; (2) the cue carried its send time on an anchor-stamped egress;
(3) the consumer anchored on tsdemux's PTS of a sparse KLV-only TS (±3 s wander).

Decision:
- The PES PTS is the cue's content time: the page's PTS put on the house timeline
  from the bus chunk stamps (`subtitle_stamp_model`: learned only on stamp rises
  both engine reference rules agree on). Every send carries the same PES bytes
  (PTS = start, `0 --> hold`); the TS around it differs (CCs advance, no PCR on
  a re-send).
- teletext-subtitles declares `houseTimelineEgress` (stamp = PES − 1 h); its pay
  tail is `appsrc (video/mpegts) ! bus sink`, the bridge packing each cue
  (`subtitle_pack`: mpegtsmux's layout, null-padded to 7 packets so a
  restarting tsdemux decodes the first cue at once).
- The consumer anchors a cue on the stamp of the bus chunk its PES started in
  (`t0src=chunk`), queues cues by start, draws each on its frame.
- `subtitle_bridge` is a python-only hook by decision (ADR-0020 allows a hook
  without a native form): every description carrying it pins `runner: 'python'`.
  The C++ twin, which implemented the 2026-09-16 behaviour and would have
  corrupted the bus against the TS pay tail, was deleted, not ported. Cost,
  accepted: ~20 MB RSS and a few % of a Pi 5 core per subtitled pipeline
  (teletext-subtitles; players and transcoders with a subtitle source wired).
- The bridge's one continuous per-packet job, the producer's source walk
  (`sourceDemux`: private PES assembly + the floor model over every bus chunk
  of the program), runs natively: `mrpeshouse` (`mpegts-core/native/mrpeshouse`,
  mrts helpers) spliced in front of the source tsdemux, its `pes-house` signal
  filling the bridge's join index. `subtitle_ts.PesStamper` +
  `subtitle_stamp_model.StampModel` are its spec and the fallback when the
  `.so` is missing (parity pinned bit-exact on dumped vectors and PES by PES
  through the real element). The per-PES and per-cue work stays python.

Consequences: cueLate 4–5 ms on the gate with the transcoder hold; traces
`cue … late=` and `show … cueLate= cueLag= frameLag= t0src=`, `lateMs` in the
module status; the egress trace is opt-in (`MR_SUBTITLE_EGRESS_TRACE=1`). At
start-up, pages before the first chunk-stamp join are timed on tsdemux (~1 s
late here; warned once per pad).

Not fixed: arriving on time (a renderer still holds video for the
broadcaster's lead — the transcoder's `subtitleDelayMs`, ADR-0005); hops that
re-stamp a private PES at arrival (a KLV-only splitter leg, the muxer's cue
pad) show the cue on arrival, keeping its original span (a re-send within
2.5 s of the last copy never moves it); audio-leading sources with the engine's timing PID
unknown miss ~1 in 4 cues until the engine learns it from PCR. Investigation
and the stamp model: docs/research/subtitle-content-time-20261009.md.
