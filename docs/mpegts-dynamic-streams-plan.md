# MPEG-TS Muxer/Demuxer — Dynamic Stream Detection & In-Band Naming Plan

| Field            | Value                              |
|------------------|------------------------------------|
| Document         | PLAN-MR-MPEGTS-DYN                 |
| Version          | 1.0                                |
| Date             | 2026-06-12                         |
| Organisation     | BCC South Africa                   |
| Related          | IMP-MR-2.0, FDS-MR-2.0             |
| Status           | Phases 0–3 done — Phase 4 (subtitles/SDT) optional |

---

## 1. Goal

Make the mpegts-muxer / mpegts-demuxer pair dynamic and self-describing:

- The demuxer **auto-detects** the streams inside an incoming TS (video, audio,
  later subtitles) instead of requiring the user to pre-configure
  `videoStreamCount` / `audioStreamCount` to match the source.
- The muxer **names** its streams; the demuxer surfaces those names as port
  labels on the other end — across any number of hops (UDP / RIST / SRT),
  across boxes, and across manager domains.

## 2. Design Decisions (settled)

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Fully self-contained — no manager lookup, ever.** All identity and naming travels inside the TS itself. | Survives cross-box, cross-manager, and manager-down scenarios. Decided after evaluating graph traversal (breaks at RIST hops — the A→B link is address-configured, not a graph edge) and program-number→manager-map lookup (breaks across manager domains). |
| D2 | **Name channel = private KLV metadata PID** (`meta/x-klv`), JSON payload, re-sent ~1/s carousel-style. | Single-program TS preserved (tsdemux only demuxes one program at a time, so SDT-per-stream would force `tee ! N× tsdemux`). mpegtsmux/tsdemux KLV caps confirmed on fleet GStreamer 1.22. Invisible-but-harmless to third-party receivers. |
| D3 | **Deterministic PIDs** via mpegtsmux request-pad naming (`sink_<pid>`): video-N → 0x100+N, audio-N → 0x140+N, subtitle headroom above, metadata PID fixed. | PID is the stable join key between detection and naming, and makes demuxer port identity stable across restarts. |
| D4 | **Names originate at the muxer, engine-local only**: optional per-input name field in muxer config, falling back to the `sourceModuleId` already present in the engine's connection records. | No manager involvement (D1). Friendly auto-names from the routing graph were dropped with the manager lookup. |
| D5 | **Discovery populates config; it never replaces it.** Discovered streams are written into the demuxer module config; ports persist offline and missing streams show as stale (red node badge + panel entries). *Refined post-Phase 3:* a stale stream with **zero connected consumers** is garbage-collected after the post-start grace; anything with a connection is never auto-removed. | Preserves the configure-then-run broadcast model — ports and downstream connections must survive a source going dark. Unconnected-port GC is risk-free: re-discovery recreates the identical PID-derived port id. |
| D6 | **Metadata can only add labels.** No state of the KLV channel — absent, malformed, oversized, or stale — may affect stream routing or pipeline health. | A TS without metadata (external encoder) is the same code path as the happy path minus labels; a malformed packet must never crash the runner (runner crash = pipeline restart = on-air glitch). |
| D7 | **Mid-run PMT changes are out of scope.** New streams appearing in a running TS are picked up on the next pipeline (re)start, not live. | Live rule/branch addition to a running pipeline is a large runner feature; a rebuild glitches all flowing outputs. Revisit only if a real need appears. |
| D8 | **SDT deferred indefinitely.** Only justified if third-party receivers must see names in VLC etc. | Brings multi-program restructuring (see D2) and a 1.22 section-injection spike. |

## 3. Wire Format (KLV payload)

```json
{ "v": 1,
  "streams": [
    { "pid": 256, "media": "video", "name": "Cam 1" },
    { "pid": 321, "media": "audio", "name": "FOH Mix" }
  ] }
```

Rules: `v` is mandatory; receivers ignore unknown fields and unknown versions;
unmatched PIDs are skipped; payload parse cap of a few KB. This is a wire
protocol crossing version boundaries during rolling fleet upgrades — the
version stays 1 and new fields are optional.

*Extended 2026-07-19 (stream-info layering):* entries may carry optional
`codec` / `channels` / `rate` fields, populated ONLY for streams MPEG-TS
cannot signal natively (WebVTT, private payloads — `capsStreamInfo().nativeTs
=== false`). Natively-signalled data (stream types, AAC/Opus/BSSD descriptors,
ISO 639 language — the muxer can now WRITE language descriptors via a
per-stream `language` config → `taginject`) always rides the PMT itself and is
never duplicated into KLV. v1 receivers ignore the extra fields.

The carousel was briefly retired (2026-07): the live `do-timestamp` appsrc got
picked as the mpegtsmux **PCR stream**, clocking receivers off the 50 ms
carousel timer (sporadic audio drops). Reinstated with a hard invariant: the
appsrc is only ever emitted together with a `prog-map` pinning `PCR_1` to the
first media pad (see `mpegtsMuxerPipeline.ts` + the invariant test).

Label resolution order at the demuxer:
**KLV name → ISO-639 language descriptor → generated** (`Audio (aac, PID 0x141)`).

## 4. Phases

### Phase 0 — KLV spike (½ day, gating)

The single point of failure of the whole plan. If 1.22 KLV is broken, the
fallback is SDT and the plan must be re-costed.

- Prove: appsrc (`meta/x-klv,parsed=true`, do-timestamp) → mpegtsmux schedules
  the packets; tsdemux exposes the KLV pad (verify exact pad name/caps);
  appsink reads the payload back.
- Test matrix: happy path, **no KLV PID**, truncated payload, junk bytes,
  oversized buffer, metadata PID excluded from user-visible streams.

#### Phase 0 findings (GStreamer 1.22.0, this box)

KLV path **works end to end on 1.22** — the plan keystone holds, no SDT fallback
needed. Reproducible script: `plugins/mpegts-muxer/spike/klv_spike.py` (run it;
exit 0 = PASS). Observed:

- **mpegtsmux accepts `meta/x-klv,parsed=true`** on its `sink_%d` request pad
  (confirmed in `gst-inspect-1.0 mpegtsmux` sink caps). PIDs pin exactly via the
  request-pad name `m.sink_<pid>` — e.g. `sink_256` → PID `0x100`,
  `sink_321` → `0x141`, `sink_300` → `0x12c`.
- **tsdemux exposes the metadata pad** as `private_<program>_<pidhex>` —
  observed name **`private_0_012c`**, caps **`meta/x-klv, parsed=(boolean)true`**.
  (Audio/video pads are `audio_0_0141` / `video_0_0100` — pad name format is
  `<media>_<programhex>_<pidhex>`, media ∈ {video, audio, private, subpicture}.)
- **PMT** (via `GstMpegts.message_parse_mpegts_section`, `SectionType.PMT`)
  lists the KLV PID with **stream_type 6** (`PRIVATE_PES_PACKETS` / `0x06`);
  video = 27 (H.264), audio = 15 (AAC-ADTS). PAT is on PID `0x0`, PMT on the
  program's PMT PID. Sections arrive as `Gst.MessageType.ELEMENT` bus messages.
- **appsink reads the KLV payload back byte-perfect** — 8 carousel copies of the
  JSON came through intact.
- **Garbage matrix all PASS** (no reader crash): no-KLV-PID (absence is a clean
  non-event, demuxes with no private pad), truncated payload, junk bytes,
  200 KB oversized buffer, single byte.

1.22 quirks worth carrying into Phase 1/2:

- **A `queue` is mandatory between each tsdemux pad and its appsink.** An appsink
  linked straight onto the demux pad back-pressures tsdemux's streaming loop and
  the entire TS stalls (no pads activate, no EOS — the "No program activated
  before EOS" failure). The runner already builds parser/queue chains per pad, so
  this is naturally satisfied there, but the demuxer's KLV appsink (Phase 2) must
  keep a queue in front of it.
- PyGI `Gst.Buffer.map()` takes `Gst.MapFlags.READ`, returns `(ok, mapinfo)`.
- `Gst.Buffer.new_wrapped(b"")` aborts (null data) — never push a zero-length KLV
  buffer; the smallest garbage case is a single byte.

### Phase 1 — Stream inspector + PID pinning

- Muxer: request `mpegtsmux` pads as `sink_<pid>` per the D3 PID scheme.
- Runner: emit `stream_discovered` events (PID, caps/codec, media type) from
  pad-added (extends the existing `pad_linked` emit path; `GstRunner` event
  switch gets the new case). (A parallel PAT/PMT `ts_program` forwarding path
  was prototyped here but dropped post-review — Phase 3 keyed ports off the
  per-pad PID from `stream_discovered`, so the section path had no consumer.)
- Demuxer: status panel listing discovered streams (codec, PID, media type) —
  no port-model change yet.
- Fold in `udpsrc timeoutNs` on both modules' inputs (silent-source detection;
  currently a stalled input is invisible and can stall the muxer's aggregate
  output with no bus error to trigger `restartOnError`).

### Phase 2 — In-band name channel

- Muxer: KLV injection (appsrc + runner-side periodic push), per-input name
  config field (engine-local fallback per D4). Name edits are live — a new
  KLV buffer updates labels downstream without pipeline rebuild.
- Demuxer: runner attaches appsink to the KLV pad, parses per D6 (one-shot
  warning on garbage, never an exception), emits `stream_names`; module merges
  onto PID-keyed streams; keep last-known labels if metadata disappears.

### Phase 3 — Auto-created ports  *(done)*

- Demuxer: discovery writes found streams into module config (D5) as a
  `discoveredStreams` array (`{pid, media, codec?, name?}`), diffed so a steady
  detection/name carousel doesn't re-write SQLite. Port IDs are PID-based
  (`pid-0x141`); offline label falls back to the persisted name/codec, live
  labels still resolve via the inspector. A persisted-but-absent stream is kept
  and rendered **stale** (never auto-removed). The metadata PID is never
  persisted as a port (D6).
- Migration (the choice that *cannot* break existing connections): PID-based
  ports are emitted **alongside** the legacy positional `video-N`/`audio-N`
  ports (kept while the counts are in config), so a deployed graph's edges
  never dangle. A still-connected legacy port is routed to its mapped PID
  (`legacyPortIdToPid`, mirroring the muxer's ordinal→PID pinning) — fanned out
  via a `tee` in the runner alongside the `pid-…` port. Before any discovery,
  legacy ports route positionally exactly as before. (Considered and rejected:
  a hard either/or swap that orphans `video-0` edges the instant discovery
  runs.)
- Runner/engine generic surface: `PadLinkRule.matchPids` matches demux pads to
  branches **by PID** (pad name carries the PID) instead of pad-added order,
  fixing the long-standing positional fragility; a PID listed twice triggers a
  `tee` fan-out. Validated on hardware via
  `plugins/mpegts-muxer/spike/pid_routing_spike.py`.
- Port-list refresh end to end: a plugin's `emitConfigUpdate` that changes
  `discoveredStreams` triggers `ModuleLifecycle.refreshPorts` →
  `onDynamicPortsResolved` → `/modules/<id>/ports` patch + PortRegistry update →
  manager broadcast → Pinia store → Vue Flow node, no reload.
- `assignUdpPort` keys per discovered-stream PID port (and per legacy port);
  `requiresOrderedApply` is set on every output port as before.

### Phase 4 — Optional / when justified

- Subtitles/teletext: `subtitle` media type in runner classification + parser
  table (`subpicture/x-dvb`, teletext — mpegtsmux accepts both on 1.22).
- SDT service names (only per D8).

### Phase 5 — Output pacing (opt-in burst smoothing)  *(done)*

**Problem.** A bursty source (the hls-player emits at HLS segment boundaries —
its own paced sink (`PacedUnixStreamTsSink`) paces to media rate, but Node event-loop stalls during
segment transmux cause micro-bursts) feeds `udpsrc ! tsdemux`, and each
per-output branch ends in a SMALL queue. Video uses `leaky=2
max-size-buffers=2` (2 frames); audio `leaky=2 max-size-time=50ms`. Under a
burst those tiny queues overflow and, being `leaky=2`, DROP the oldest buffers
mid-frame → corruption/choppiness at the receiver and growing audio delay. The
same hls-player sent straight via srt-output is clean — so it's the demuxer's
output buffering, not the source.

**Goal.** One configurable layer that serves both stated scenarios: HLS (large
latency OK, smoothness matters — wants seconds of jitter buffer) and live (low
latency critical — must keep today's tight behaviour). A single per-instance
`outputBufferMs`, default **0 = OFF = today's exact pipeline strings,
byte-for-byte**. When > 0, each output branch prepends a buffering layer that
absorbs bursts without dropping.

**Chosen mechanism (spike-validated).** Prepend ONE deep **non-leaky** queue
ahead of the existing (unchanged) per-branch `queue ! mpegtsmux ! udpsink`:

```
queue leaky=0 max-size-time=<outputBufferMs>ms max-size-buffers=0 max-size-bytes=0 ! <today's branch>
```

`leaky=0` = BLOCK-not-drop: a burst is absorbed into the depth instead of shed.
No `tsparse`, no PCR re-anchor, no change to `mpegtsmux latency`/`alignment` —
purely an additive upstream buffering layer, so the no-tsparse/PCR rule and the
per-media alignment (1 audio / 7 video) are untouched. Default 0 emits no extra
element at all.

**Candidates evaluated and rejected.**
- *Larger `leaky=2` window* — still DROPS under a sufficiently long burst;
  wrong policy for smoothing.
- *`udpsink sync=true` egress pacing* — depends on the PTS that mpegtsmux
  `alignment` clusters onto packed datagrams; in the spike it did not reliably
  re-pace and added jitter when the input wasn't bursting. Rejected as
  timing-fragile (and `sync=true` on a dark/late source risks egress stalls).
- *`min-threshold-time` (fill-then-drain)* — releases the held data as another
  burst at the drain edge rather than re-pacing; no jitter win in the spike.

**Back-pressure (the real landmine).** A non-leaky queue on ONE branch of the
SHARED `tsdemux` could in principle block ALL branches (the hls→demuxer→
video+audio case has multiple branches off one demux). The spike runs the
multi-branch case and asserts the OTHER branch keeps delivering: with the queue
sized to the window the burst fits inside it, so `tsdemux` is never
back-pressured past the window and sibling branches never starve. Verified
stable across 7 runs.

#### Phase 5 findings (GStreamer 1.22.0, this box)

Spike: `plugins/mpegts-demuxer/spike/output_pacing_spike.py`. Builds a 2-program
TS (video PID 0x100 + audio PID 0x141), makes the UDP egress BURSTY (non-leaky
`min-threshold-bytes` sender → `sync=false` udpsink dumps clumps), feeds it
through `udpsrc ! tsdemux` with BOTH branches attached, and compares today's
strings (`smoothing=False`) vs the deep non-leaky pre-queue (`smoothing=True`).
It probes each branch's first queue sink/src pads and counts buffers IN − OUT =
buffers the queue SHED — the direct, deterministic drop measurement (downstream
continuity counters can't show it, mpegtsmux re-stamps them).

Result (representative; PASS 7/7):
- Baseline LEAKY queues SHED buffers under burst every run (1–25 buffers).
- The NON-LEAKY smoothing queue SHED **0** every run.
- Both branches delivered under smoothing — **no cross-branch stall**.

Exit 0 = PASS. Mechanism valid on 1.22; `queue leaky=0 max-size-time=…` and the
unchanged tail are core elements stable across 1.22→1.24, so no 1.24-specific
caveat (re-run the spike on the device to re-confirm if desired).

## 5. Known Limitations (accepted)

- External (non-media-router) sources get detection + language tags, never
  custom names. Permanent consequence of D1.
- Third-party receivers don't see names without SDT (D8).
- A remux stage in the path rewrites PIDs and drops the metadata PID — the
  new mux stage becomes the naming authority. Considered correct.
- New streams mid-run require a pipeline restart (D7).

## 6. Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| GStreamer 1.22 KLV path broken/incomplete | Plan keystone | Phase 0 spike before any committed work; fallback = SDT (re-cost) |
| Wire-format drift across fleet versions | Mislabeled streams | `v` field + ignore-unknown rule; never repurpose fields |
| Port-identity migration breaks existing graphs | Dangling connections | Legacy positional-ID mapping in Phase 3; test against a copy of production config |
| Runner crash from malformed metadata | On-air glitch | D6 invariant + Phase 0 garbage-input matrix |
