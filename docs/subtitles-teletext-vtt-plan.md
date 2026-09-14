# Subtitles: teletext → WebVTT transcoder, TS side-channel transport, burn-in

| Field        | Value                                   |
|--------------|-----------------------------------------|
| Status       | Stages 0–7 implemented 2026-09-09 (uncommitted); field test pending — see docs/TodoNotes.md and ADR-0016 |
| Date         | 2026-09-09                              |
| Related      | docs/mpegts-dynamic-streams-plan.md (Phase 4 placeholder), ADR-0005, ADR-0011, ADR-0013 |

## 1. Goal

1. A **teletext → WebVTT transcoder** module: one `muxed/mpegts` input carrying a
   DVB teletext PID; decodes the teletext once and exposes **one output per
   configured page** ("channel", e.g. 888 = English, 889 = Afrikaans).
2. **Transport** the subtitle stream between modules and boxes as an MPEG-TS
   side channel so it rides the existing bus, SRT/RIST/UDP outputs and the
   muxer unchanged.
3. A **subtitle input dot** on the video-player and the video transcoder that
   renders (burns in) the text, with operator control of position and size.

## 2. What the research found (2026-09-09)

### 2.1 Current state of the tree / fleet

- **teletextdec is NOT on the fleet image.** `gst-inspect-1.0 teletextdec` on
  10.9.16.103 (gst 1.28): missing. The July 2026 zvbi recipe + `teletext`
  PACKAGECONFIG never landed in git (the backup README records an *empty*
  `recipes-multimedia/zvbi/` dir). Must be redone — details are known:
  custom `zvbi_0.2.44.bb` (git fetcher, `--without-x`, DEPENDS libpng zlib),
  bbappend `PACKAGECONFIG[teletext] = "-Dteletext=enabled,-Dteletext=disabled,zvbi"`
  (oe-core hard-disables it in EXTRA_OEMESON; same trick as the ladspa flag).
- Present on the box: `subparse`, `webvttenc`, `textoverlay`, `textrender`,
  `subtitleoverlay`, `dvbsuboverlay`, `dvbsubenc`, pango.
- `mpegtsmux` sink caps (1.28): `subpicture/x-dvb`, `application/x-teletext`,
  `meta/x-klv (parsed=true)`, `meta/x-id3 (parsed=true)`, `meta/x-st-2038`,
  plus the A/V codecs. **No text or VTT caps.**
- `tsdemux` (upstream source, verified): a stream_type 0x06 PID whose
  descriptors it does not recognise gets **no pad at all** — the switch falls
  through with `caps == NULL` and the stream is silently skipped. Recognised:
  teletext desc → `application/x-teletext` (sparse), DVB-sub → `subpicture/x-dvb`,
  KLVA → `meta/x-klv`, ID3 → `meta/x-id3`, VANC → `meta/x-st-2038`, plus the
  audio/video registrations. Private-stream buffers DO carry PES PTS.
- **hls-pipe already muxes WebVTT into TS** (`packages/hls-pipe/src/mux/ts/`):
  stream_type 0x06 + registration_descriptor `"VTT "`, one cue per PES with
  PTS. Because of the previous point, **no GStreamer consumer in the fleet can
  see that PID** — there is no `"VTT "` consumer anywhere in the repo. The
  house format therefore has to move to a carrier tsdemux exposes.
- The KLV metadata channel (muxer name carousel, PID 0x1f0, `meta/x-klv`,
  runner `set_klv_payload` + appsrc) is production-proven end to end and its
  wire format already reserved optional `codec: "webvtt"` entries for streams
  TS cannot signal natively (`klvPayload.ts`, `capsStreamInfo.ts`).
- `tsHelpers.ts` reserves PID headroom for subtitles between audio (0x140…)
  and metadata (0x1f0). Shared types already have `StreamType 'text/subtitle'`
  (reserved, unused), `StreamMedia 'subtitle'`, and a sky-blue subtitle chip in
  `portDisplay.ts`. The runner classifies `application/x-teletext` and
  `subpicture/*` pads as `subtitle`. The ts-splitter reports 0x06 as
  `data/private` and does not read the teletext (0x56) / DVB-sub (0x59)
  descriptors yet.
- The bus carries **only** TS (`BUS_TS_CAPS`) and PCM via PipeWire; there is
  no non-TS video/text bus path. So inter-module subtitle transport = TS.
- `textoverlay` properties on the box: `halignment valignment xpos ypos
  x-absolute y-absolute deltax deltay xpad ypad font-desc auto-resize
  scale-mode text-height text-width line-alignment wrap-mode color
  outline-color draw-outline draw-shadow shaded-background shading-value
  wait-text silent`. Live-settable via the existing `setElementProperty`.
- `teletextdec` (upstream source): sink `application/x-teletext`; src
  `text/x-raw {utf8, pango-markup}` or RGBA video. One page per instance
  (`page` is decimal 100–999, `subpage -1`). Emits one buffer per zvbi page
  event with **PTS/duration copied from the input PES buffer**; in
  `subtitles-mode` blank/state lines are stripped and an empty page yields a
  single `"\n"` (the "clear" signal). Pango output carries foreground colours.
  No GAP handling, assumes 25 fps VBI cadence.
- `webvttenc`: `text/x-raw → application/x-subtitle-vtt`; first buffer is the
  `WEBVTT\n\n` header, every later buffer is exactly one cue block (timing line
  from PTS + duration, default duration 1 s when unset). Usable as a live
  per-cue chunker.

### 2.1a Field sample: NO-OCC-Gate01 (2026-09-09)

Engine `NO-BR-Gate01` (fleet manager 10.9.16.20, profile `import`) takes
multicast `239.255.0.191:5500` on eth0 into a TS Splitter, which lists
`Data (private, PID 0x20)` beside H.264 video and 23 AAC languages. A 15 s
capture on the box (`ttx_probe.py`, read-only multicast join) shows:

- PMT entry `stream_type 0x06, PID 0x20` with a **teletext descriptor (0x56)**
  carrying eight `teletext_type = 2` (subtitle page) entries:

  | lang | page | lang | page |
  |------|------|------|------|
  | nor | 692 | fra | 600 |
  | deu | 150 | spa | 610 |
  | nld | 695 | ron | 620 |
  | eng | 888 | pol | 630 |

- ~75 TS packets/s on the PID (~113 kbit/s); data units are 99 % `0x03`
  (EBU teletext subtitle), with the eight pages above cycling every ~2–3 s
  plus non-subtitle pages 265/765/965 (`0x02`).
- The PMT is longer than one TS packet (24 ES entries) — any PSI reader must
  reassemble sections.
- The splitter labels it `Data (private)` because `streamTypes.ts` maps 0x06
  without reading descriptors; the descriptor loop is already delivered to the
  module (`esInfo`), so the label fix is local to the splitter. The same gap
  makes our own KLV name carousel (PID 0x1f0, which mpegtsmux emits as 0x06 +
  KLVA registration) show as `Data (private, PID 0x1f0)` on every gate.

Consequence for the transcoder: the teletext descriptor already names every
subtitle page and its language, so the module can **auto-populate its page list
from the PMT** (operator can prune/rename) instead of requiring manual page
entry — answers open question 1.

### 2.1b Spike results (2026-09-09, Stage 1 + first half of Stage 2 done)

- **Yocto**: `recipes-multimedia/zvbi/zvbi_0.2.44.bb` + the `teletext`
  PACKAGECONFIG in the plugins-bad bbappend + `gstreamer1.0-plugins-bad-teletext`
  in the image list are in the dev tree (uncommitted). Built for raspberrypi5
  on the build server through a scratch layer (`scratch-ttx/`, CI checkout
  untouched): `zvbi_0.2.44` and `gstreamer1.0-plugins-bad-teletext_1.28.2`
  ipks. Hot-loaded on 10.9.16.103 from `/tmp/ttx` (GST_PLUGIN_PATH +
  LD_LIBRARY_PATH), no rootfs change.
- **Synthetic teletext generator** (`ttx_gen.py`, scratch tool, also on
  .103:/tmp): a real DVB teletext subtitle stream over UDP, verified against
  libzvbi directly, teletextdec and ffmpeg. zvbi rules learned the hard way
  (all silent failures): one PES per 40 ms frame with a time-filling header
  (page 0xFF) per magazine in use when idle; C4 erase on every cue
  transmission; PES length N*184-6; identical header text across pages.
- **Overlay on .103's display works** (`ttx_overlay.py`: videotestsrc →
  textoverlay ← udpsrc → tsdemux → teletextdec, waylandsink fullscreen under
  the kiosk shell). Three GStreamer facts that shape the real implementation:
  1. `teletextdec` emits `text/x-raw,format=utf-8`; `textoverlay` accepts only
     `utf8`/`pango-markup` → a caps rename is needed (or our own depay emits
     `utf8` directly).
  2. `teletextdec` appends a trailing NUL; textoverlay's UTF-8 validation
     turns it into a visible `*`. Strip it.
  3. **The flashing**: textoverlay shows a text buffer only while
     `[pts, pts+duration)` overlaps the video running time, and a buffer with
     no duration is shown for ONE frame then popped. tsdemux gives teletext
     PES a PTS (on the source timeline) but no duration. The cue therefore
     needs a PTS on the consumer pipeline's timeline and a real duration (cue
     end time, or hold-until-next). `wait-text=false` keeps video flowing
     when no cue is present. Default `subtitles-template` prints a literal
     `\n`; pass a real newline.
  Consequence for the design: the KLV-wrapped WebVTT cue must carry an end
  time (the VTT timing line does), and the depay stamps `pts = cue start on
  the house timeline`, `duration = end - start`. Blank teletext page → cue
  end.

### 2.2 Transport options for text in MPEG-TS

| Option | Native in mpegtsmux/tsdemux? | Third-party visible? | Notes |
|---|---|---|---|
| A. **WebVTT cue in a KLV PES** (`meta/x-klv,parsed=true`, own PID, PTS = cue start) | yes, both ends, gst 1.28 | no (VLC ignores KLV) | Reuses proven muxer/runner KLV path. Needs a tiny pay/depay: text ↔ KLV triplet. **Recommended house carrier.** |
| B. hls-pipe's `0x06 + "VTT "` private PES | mux: no (needs custom TS writer); demux: **no pad** | no | Dead end for GStreamer consumers; only keep for hls-pipe internal use or migrate hls-pipe to A. |
| C. `meta/x-id3` (HLS timed-metadata style, TXXX frame) | yes | partially (HLS players read ID3, but not as subtitles) | No advantage over A; extra ID3 framing. |
| D. **Teletext pass-through** (`application/x-teletext`, 0x06 + 0x56) | yes | yes — TVs/VLC decode teletext subs | Zero conversion, but no per-channel outputs and the player must decode/pick the page itself. Cheap to support as a *bonus* on the muxer. |
| E. **DVB subtitles** (`teletextdec ! textrender ! dvbsubenc ! subpicture/x-dvb`) | yes | **yes** — standard broadcast subs (VLC, STBs, TVs) | Bitmap: position/size baked at encode time, ~5–20 kbit/s. The right answer for **outputs leaving the fleet** to third parties. |
| F. Non-TS bus stream (`text/subtitle`) | n/a | n/a | No bus path exists for non-TS media; would need a new transport family. Rejected. |

No ISO/DVB standard carries WebVTT in MPEG-TS (ISO 14496-30 covers ISOBMFF
only; HLS carries VTT as separate segments). Any VTT-in-TS is by definition a
house format, so the choice is only about which carrier the toolchain already
speaks: that is A.

## 3. Proposed decisions (to confirm)

| # | Decision | Rationale |
|---|---|---|
| S1 | House subtitle carrier = **KLV-wrapped WebVTT cue** on its own PID: `meta/x-klv,parsed=true`, stream_type 0x15, registration KLVA, PES PTS = cue start, payload = one SMPTE 336M-style triplet (16-byte house UL key, BER length, UTF-8 WebVTT cue block incl. timing line). | Both mpegtsmux and tsdemux handle it natively with PTS; the fleet muxer/runner already push and read KLV; a valid KLV triplet keeps third-party analysers from choking. The cue block's own `start --> end` line gives the renderer an explicit clear time (PES has no duration). |
| S2 | Deterministic PIDs: `TS_SUBTITLE_PID_BASE = 0x180`, subtitle-N → 0x180+N (below 0x1f0 metadata). | Extends the D3 scheme; the reserved headroom exists for this. |
| S3 | The KLV **name carousel** (0x1f0) advertises subtitle PIDs with `media: "subtitle"`, `codec: "webvtt"`, `language`, `name` (page number as default name). | `KlvStreamMedia` grows `'subtitle'`; receivers on v1 ignore unknown media. Layering rule holds: webvtt has no native TS signalling so codec goes in KLV. |
| S4 | Each transcoder output is a **single-program TS with one subtitle PID** (`muxed/mpegts` port, `streamInfo.media = 'subtitle'`); PCR pinned to that PID. | Same shape as every other bus producer; wires into the muxer, SRT/RIST outputs, and the new subtitle dots without a new stream family. Consumers that must not receive a subtitle-only TS (e.g. video dot of the player) reject via `acceptsStreamTypes`/`streamInfo.media`. |
| S5 | Timeline: the transcoder runs `preserveSourceTimeline` on its tsdemux so cue PTS = source PES timeline, then the producer stamper maps to house time like every producer (ADR-0005). | A cue stamped on the same contract as the video it came from lands in sync at any consumer, across boxes, with no side-channel offset. |
| S6 | Rendering = `textoverlay` fed by a small **depay** (`meta/x-klv → text/x-raw,format=pango-markup`), `wait-text=false`. Position/size = `halignment/valignment/xpos/ypos/font-desc/auto-resize/shaded-background`, all `x-live`. | Player already ships textoverlay for the fallback caption; live element props already exist. `wait-text=false` so a sparse/absent subtitle input never stalls video. |
| S7 | Pay/depay live as **native elements in `plugins/mpegts-core/native`** (`mrklvtextpay`, `mrklvtextdepay`), ADR-0013 style, loaded by path. Spike may use a runner-side python appsink/appsrc bridge first (cue rate is ~1/s, so CPU is irrelevant); the native pair is for clean pipeline strings and no runner special-casing. | Consistent with ADR-0001/0013; the mux/demux side needs nothing custom. |
| S8 | **DVB-sub output (option E) is a later, separate output mode** of the transcoder ("also emit DVB subtitles" per page), not part of the first cut. | Needed only when a downstream is a third-party receiver; bitmap path has its own tuning. |
| S9 | hls-pipe's `"VTT "` private-PES writer is migrated to S1 when the player dot exists, so HLS subtitle languages become visible to the same renderer. | Removes the dead format; one carrier fleet-wide. |

## 4. Architecture

```
SRT/RIST in ─muxed/mpegts─► ts-splitter ─pid-0x…(teletext)─► teletext-vtt-transcoder
                                                                 │ tsdemux(preserveSourceTimeline)
                                                                 │  └ application/x-teletext ─ tee
                                                                 │      ├ teletextdec page=888 subtitles-mode ! mrklvtextpay ! mpegtsmux(sink_0x180) ! bus  ─► out "888 eng"
                                                                 │      └ teletextdec page=889 subtitles-mode ! mrklvtextpay ! mpegtsmux(sink_0x180) ! bus  ─► out "889 afr"
video TS ─────────────────────────────────────────────────────────────────────┐
                                                                             ▼
                                                     video-player: unixfdsrc(video) ! tsdemux ! … decoder ! textoverlay ! sink
                                                                    unixfdsrc(subs)  ! tsdemux ! mrklvtextdepay ! textoverlay.text_sink
```

Per-channel outputs share ONE teletext decode input; `teletextdec` is per page
(one element per output — decode cost is negligible, it is text). The source
can be the splitter's teletext PID port or the full program TS (the
transcoder's capsfilter selects `application/x-teletext`, like the video
transcoder selects `video/x-h264`).

Consumers:

- **video-player**: second input port `subtitles-in` (`muxed/mpegts`,
  `acceptsStreamTypes: ['muxed/mpegts']`, subtitle-only by `streamInfo.media`),
  max 1. Config group "Subtitles": position (9-way alignment + x/y offset),
  size (font-desc / relative `text-height`), background box, colour, outline;
  all live. The existing fallback `textoverlay name=nov` stays separate.
- **transcoder (ABR)**: same `subtitles-in` dot; `textoverlay` sits on the
  shared decoded frame BEFORE the tee (one burn-in for all renditions,
  `auto-resize` keeps size relative). Optional later mode: pass the subtitle
  PID into each rendition's TS instead of burning in (mux `meta/x-klv` into
  `mux_i`).
- **mpegts-muxer**: accept subtitle-media TS inputs on new `subtitle-N`
  ports → `sink_<0x180+N>`; carousel entry per S3 (delivers "VTT alongside the
  programme" for fleet receivers; option D teletext pass-through falls out of
  the same rule since `application/x-teletext` is already mux-able).
- **ts-splitter**: read descriptor 0x56/0x59 so the port label reads
  `Subtitle (teletext, PID …)` instead of `Data (private, …)`; classify KLVA
  metadata with our subtitle UL as `subtitle/webvtt`.

## 5. Stages

0. **Yocto: re-land zvbi + teletextdec** (branch v2). Custom `zvbi_0.2.44.bb`
   (git fetcher + SRCREV; wrynose bans archive URLs), bbappend PACKAGECONFIG,
   verify with the sysroot `gst-inspect` trick on the Pi 5 dev box, then
   image build. Exit: `gst-inspect-1.0 teletextdec` on a fleet box.
1. **Spike (no plugin code)**: on .103 with a captured teletext TS
   (`docs/research/` gets the capture + numbers):
   `tsdemux ! application/x-teletext ! teletextdec page=888 subtitles-mode=true`
   → confirm cue text, PTS behaviour, clear semantics, colour markup; then
   `… ! appsink → KLV wrap → appsrc caps=meta/x-klv,parsed=true ! mpegtsmux`
   and the reverse through `tsdemux → textoverlay`. Exit: subtitles render on
   a display in sync with video from a separate TS; measure cue→render lag.
2. **Carrier + helpers**: `TS_SUBTITLE_PID_BASE`, `KlvStreamMedia 'subtitle'`,
   `capsStreamInfo` for `meta/x-klv` with the house UL, runner classification
   of that pad as `subtitle`, native `mrklvtextpay/depay` in mpegts-core
   (+ unit tests, byte-exact KLV fixture). ADR: "Subtitle carrier is
   KLV-wrapped WebVTT".
3. **teletext-vtt-transcoder plugin**: manifest (`pages: [{page, language,
   name}]` array → dynamic output ports, like transcoder renditions),
   pipeline builder (pure `…Ports.ts` + `…Pipeline.ts` per house pattern),
   status (cues/s per page, last cue text, teletext PID present/absent
   health), `preserveSourceTimeline`. Tests: ports, pipeline string, status.
4. **video-player subtitle dot + rendering**: second bus input, depay →
   `textoverlay`, live position/size/style props, health when subtitle input
   is wired but silent (never blocks video). On-display verification on .103.
5. **transcoder burn-in dot**: same helper, pre-tee overlay; verify all
   renditions carry the text and CPU delta on Pi 4.
6. **muxer + splitter**: `subtitle-N` ports, PID 0x180+, carousel entry,
   splitter descriptor labels. Field test: transcoder → muxer → RIST → far
   box → player dot.
7. **Later / optional**: DVB-sub output mode (option E) for third-party
   receivers; hls-pipe migration (S9); a "raw page dump" debug view.

## 6. Open questions for the owner

1. Source of teletext in the fleet: is it always DVB teletext (0x06 + 0x56)
   from the broadcaster SRT/RIST feeds, and which pages (888 EN, 889 AF, …)?
   A capture is needed for the spike.
2. Should the transcoder also accept a full programme TS directly (skip the
   splitter), like the video transcoder does? Proposed: yes (capsfilter on
   `application/x-teletext`), splitter optional.
3. Position control granularity: 9-way alignment + pixel/percent offsets is
   what textoverlay gives; is free x/y placement (drag on a preview) needed?
4. Third-party receivers (VLC / TV STBs) downstream of a RIST output — if yes,
   stage 7's DVB-sub mode moves earlier.
5. Rendering styling from the teletext (colours, double height) — keep pango
   colours from `teletextdec` or force a single house style? Proposed: house
   style default, "keep source colours" toggle.

## 7. Risks

- `teletextdec` assumes 25 fps VBI cadence and has no GAP handling: expect
  timing quirks on 50p or after stream gaps; the spike must cover a reconnect.
- `textoverlay` with a sparse second input: must stay `wait-text=false` and
  the depay must push a clear ("") at cue end (from the cue's end time) or the
  last line stays on screen forever.
- Cross-input sync in one pipeline depends on both tsdemux segments landing on
  the same running-time basis under the bus contract (ADR-0005, base_time=0);
  verify in the spike before building the dot.
- Pi 4 CPU: textoverlay on 1080p50 raw frames costs a pango render per text
  change plus a blend per frame; measure in stage 5 (expected small, but the
  transcoder is already CPU-bound on Pi 4).
