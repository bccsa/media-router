# Conformance fixtures

`<name>.ts` with `<name>.expect.jsonl`, its `mrts_cli dump` (and `<name>.p<N>.expect.jsonl`,
the dump following program N), replayed by `native/mrts/tests/ts_conformance_test` at 188,
1316 and 24 576-byte chunks (plan ch. 3 part 7.2, WI-S0-9). A changed expectation is
regenerated with `mrts_cli dump <name>.ts > <name>.expect.jsonl` and reviewed against
`tests/dump_vs_ffprobe.py` before it is committed. None of this ships (WI-S0-13).
Phase 3's set (ch. 7 WI-P3-3, register B-120): its `syn-*` kinds, `syn-gap-500ms` to
`syn-adts-mpeg2`, carry house PES (the first at house 1000 s, PES = house + 1 h) and are
pinned by size and CRC-32 in the conformance test;
`tp-*` are third-party muxes made once by `tools/fixtures/gen-thirdparty.sh`, rebased onto
house 1000 s; a bus recording is its raw TS plus a sidecar `<name>.bus.jsonl`, a line per bus
buffer (`off`, `len`, `pts`, `dts`, `dur` in ns or null, `flags` = GstBufferFlags, GAP 2048 and
DISCONT 64), recorded on a box by `tools/fixtures/record-bus.sh` and cut by `trim.sh` (from the
PAT before a random access point, at most 10,638 packets, sidecar and TS together). A test
replays any fixture on its own clock after `mrts_cli rebase <in> <out> --to-ns <t> [--bus <in>
<out>]`: one shift on the 100 us grid, so the sidecar moves with the PES exactly.
Arrival traces for the restamp are in `restamp/` (ch. 5 part 7.2, WI-P1-5); each
`.expect.json` there says how its trace was recorded. An expectation's `cadenceWarning` means
a PCR interval ran late against the PCR's own cadence (twice it, at least 500 ms, at most 4 s)
at some point of the replay; `pcrCadenceMs` is the cadence learned at the end (B-86). A trace
recorded before 2026-10-22 (B-84) gives a PES record the restamp's own `discontinuity_indicator`
where a PCR rode the PES's first packet and the restamp flagged it; the recorder now writes the
source's. Of the committed traces, `trace-gate01-rist-20010` (1 such record),
`trace-gate01-rist-20046` (1), `trace-srt-reconnect-backlog` (2), `trace-vmix-sparse-pcr` (427
of its 433 IDR records) and `trace-tech01-relay` (1) carry such flags, the rest none; a replay
plays them back and uses them for nothing.

Each `<name>.demux.jsonl` (and `syn-mpts-two-programs.p2.demux.jsonl`, program 2) is Phase 3's
expectation (ch. 7 WI-P3-1, register B-121): the events of `py/demux_core.py`, `mrts::DemuxCore`'s
Python reference, on the fixture, regenerated from the plugin's directory with `python3
py/demux_core.py tests/fixtures/<name>.ts [--bus tests/fixtures/<name>.bus.jsonl] [--program N] >
tests/fixtures/<name>[.pN].demux.jsonl` and held to it by `py/demux_core_test.py` (case 16). The
replay runs at the recording's own house time (its first PES - 1 h, the one clock reading for every
feed) in 1316-byte feeds (any chunking gives the same lines), every media class exposed; where a
sidecar exists, a GAP buffer is a marker and a DISCONT flag is kept. One JSON object a line, times
in ns: `{"section":{table,pid,version,len,crc32}}` when a new PAT or a changed PMT of the program
parses; `{"plan":{gen,program,pcrPid,pads:[{pad,pid,type,caps,sparse,lang,post}]}}` when the
program is new (tsdemux's rule: its PCR PID or its (PID, stream type) list changed), `gen` counting
from 0 and its low 4 bits in the pad names, `lang` the ISO 639-2 code tsdemux tags, `post` none,
adts, opus or klv; `{"unit":{pad,pts,dts,dur,len,crc32,discont}}` per PES, `crc32` of its payload,
`dur` from a 302M header, else null; `{"gap":{pad,pts,dur,reason}}`, `reason` jump, marker or
sparse; `{"gone":{gen}}`; `{"unknown":{pid,type,reg,gen}}`, `reg` the registration's four
characters; `{"nothouse":{pid,offsetMs}}`; `{"nostream":{}}`; then the `{"counters":{...}}` line.

Reviewed by hand on 2026-10-26 (B-121): every plan's pad names and caps, in order, are stock
tsdemux 1.28.2's at pad-added on every fixture but one, `syn-mpts-two-programs`, whose AVC to HEVC
change comes at an unchanged PMT version that tsdemux's section filter skips (it reads a version it
has seen as the same table) and DemuxCore acts on. Each `unknown` line here is a stream tsdemux has
no pad for either (0x06 without a descriptor, `tp-h264-dts`'s 0x82 outside a BluRay program, 0x15
without a metadata descriptor); tsdemux pads DTS as 0x8A or 0x06 + DTS1 and AC-4, which DemuxCore
names with an `unknown` line (OQ-27), measured on a synthetic PMT. Every unit is its dump's PES
(length and CRC-32), and its PTS and DTS through the floor back to 90 kHz plus 1 h are the PES's
own, on every pad of every fixture, so ffprobe's differences are the dumps' (a trim's cut last PES,
PES cut by a CC loss, OCC's PES before its PMT, ID3's 5 bytes). tsdemux refines OCC's and
`syn-adts-mpeg2`'s AAC to `mpegversion=(int)2` at the first buffer, as `adts_mpegversion` does, and
tags `lang` in ISO 639-1 (nor no, eng en, swa sw). The gaps: `syn-gap-500ms` one 512 ms jump on its
AAC pad, none on video (520 ms) or teletext; `syn-gap-marker` its two marker gaps, each from its
pad's horizon, the last video PES before the hole (unbounded, ended by the next PUSI) before its
gap; `syn-video-hole-1s` one 1.205 s jump on video, none for its 1-, 2- and 5-frame holes;
`cap-mux-align7-aac-opus`, `cap-cc-loss` and `syn-foreign-clock-aac` two jumps of about 80 ms on
the AAC pad, the gate source's own 100 ms steps; `syn-source-restart` its +3 h jump on each pad;
sparse gaps behind program time on the teletext, DVB subtitle and ID3 pads.

`plugins/mpegts-core/native/mrts/mrts_cli demux` prints the same lines from `mrts::DemuxCore` (the
same options; `py/demux_core_parity_test.py` holds the two equal at every chunking). Since B-122 a
video pad learns its frame from the DTS, not from the PTS in decode order (on B-frame content that
read three frames), which moved four expectations: one teletext sparse gap each in the two OCC trims
(40 ms longer and shorter), `syn-source-restart`'s video jump gap (from the newest PTS + one frame,
40 ms, not + 160 ms) and the DVB subtitle sparse gaps' cadence of `tp-h264-dvbsub`.

`demux_parity_allow.json` is the allowlist of the engine's `gst_mrtsdemux_parity_test.py` (ch. 7
WI-P3-4, register B-124), which replays every recorded fixture (`cap-*`, `tp-*`, `bus-*`; a bus
recording also from its sidecar) into stock tsdemux 1.28.2 and into `mrtsdemux` at 188, 1000, 1316
and 24 576-byte feeds, each feed stamped with its arrival on the recording's PCR, and compares what
every pad and the bus see. Each entry is one rule of that comparison with its reason, and each must
be used by the run; `measuredEqual` says why the brief's other expected differences need no entry
(so the harness holds them equal), and `excluded` why the `syn-*` set is left out. A recording added
here joins the run by its name; a difference it brings fails until the element changes or an entry
says why.

`forwarded-messages.json` holds one `mrtsdemux` message per `reason` and one `mrasrc-stats` and
`mrasrc-event` per `kind` as both runners forward them, unsubscribed (ch. 7 WI-P3-6, register
B-126): the engine's `demuxWatches` and `asrcWatches` tests read them, and the engine's
`native_runner_protocol_test.py` holds every payload of its mrtsdemux-messages and mrasrc-device
cases to its entry's fields and their types, so a field the element renames fails there before
the engine reads it wrong. Recorded on the dev Pi from those two cases (2026-10-27); the entries no
run of theirs posts (no-stream, the mrasrc events but device-relock) are as the elements post them.

| Fixture | Source (recorded 2026-10-16 unless dated) | What it holds |
|---|---|---|
| `syn-mpts-two-programs.ts` | `fixture_gen --ts mpts-two-programs` | The parity stream's program 1 (sparse PSI, PCR jitter, Opus, KLV, CC gaps, desync garbage, AVC → HEVC: PMT generation 2) and a second program (H.264 with DTS, MPEG-1 audio) in one PAT |
| `syn-wrap-33bit.ts` | `fixture_gen --ts wrap-33bit` (trace_gen's model, `--wrap-at 5`) | PTS, DTS and PCR across 2^33, B-frame DTS behind PTS at the wrap, teletext |
| `syn-pes-header-split.ts` | `fixture_gen --ts pes-header-split` | Video PES headers cut after 1 to 18 bytes by the PUSI packet's adaptation field, an AAC PES between the halves |
| `syn-pes-no-pts.ts` | `fixture_gen --ts pes-no-pts` | PES without PTS; padding (0xBE) and private_stream_2 (0xBF) |
| `syn-source-restart.ts` | `fixture_gen --ts source-restart` | A +3 h timeline jump at 3 s, `discontinuity_indicator` on the first PCR after, every CC from 0 |
| `cap-occ-1080i-h264-aac-ttx.ts` | The OCC multicast capture of 2026-07-17 (`occ-capture-20260717.ts`), from the PAT before the first IDR after 3 s, PIDs 0, 0x64, 0x65, 0xc9, 0xcc and 0x20 kept | 1080i H.264 with B-frames (an IDR of 442 KB), AAC ADTS, teletext, the 514-byte PMT |
| `cap-occ-1080i-h264-21aac-ttx.ts` | The same capture's first 10,638 packets from offset 0, every PID kept (WI-P2-4, plan ch. 15.4 B-54; drafted as `cap-occ-1080i-h264-mp2-ttx.ts`, renamed for what it holds, B-85) | 1080i H.264 on the PCR PID 0x65, 21 AAC PIDs, teletext on 0x20, the 514-byte PMT about 450 packets before each PAT, so the dump starts at the PMT after the first PAT (B-13); the splitter pass-through tests and `scn-split-passthrough` use it |
| `cap-mux-unbounded-video.ts` | Our mpegts-muxer remuxing the OCC replay's H.264 and AAC on the Pi 5 test box (.103), bus tap | Unbounded and bounded video PES (> 64 KB written with length 0), DTS on B-frames, `alignment=7` |
| `cap-mux-align7-aac-opus.ts` | Our mpegts-muxer muxing AAC (gate 20010 via the splitter) and Opus (an audio-transcoder) on .103, bus tap, 10 s | Several PES starts per 1316 bytes, PSI between them, bounded audio PES, the Opus registration |
| `cap-cc-loss.ts` | `cap-mux-align7-aac-opus.ts` with packets removed by `fixture_gen --drop` (the list is in the test) | CC loss mid-PES, a lost PES start, two packets in a row, a lost PMT packet |
| `cap-302m-bssd.ts` | audio-input-302m on ivan-test-p4 (.108: KT USB capture, `mrasrc`, fixed restamp), bus tap | SMPTE 302M with the `BSSD` registration, one PES per buffer, no DTS |
| `cap-klv-sparse.ts` | teletext-subtitles page 888 on .103, bus tap, 180 s | KLVA private stream (0xBD), PTS on the bus timeline |
| `cap-srt-ingest-1316.ts` | srt-input on .108 from ffmpeg's mpegts muxer (libx264 CBR, AAC, muxrate 3 Mbit/s) over SRT, the srtsrc output itself, 1519 datagrams | A third-party mux in 1316-byte datagrams, at most one PCR per datagram |
| `cap-vmix-h264-aac.ts` | The owner's vMix test source (an SRT listener, looping a recording) pulled by a standalone srtsrc caller on .103, 2026-10-21 (B-85): session A's raw TS (70 s, teed beside its trace), from the PAT before its 9th IDR (byte 22,734,276; the one GOP small enough, 7.99 Mbit/s, for two PCRs in 2 MB), every PID kept, 10,638 packets | libavformat's VBR mux: a PCR only in each IDR's first packet, one GOP (2.000 s) apart, PTS = PCR there; PAT and PMT before each IDR and every 40 packets, SDT every 200, no null packets; H.264 Main 720p50 without DTS on the PCR PID 0x101, AAC ADTS on 0x100; two PCRs. Not #820's CBR mode |
| `syn-gap-500ms.ts` | `fixture_gen --ts gap-500ms` | H.264 without DTS on the PCR PID 0x100, AAC on 0x102, teletext on 0x103 every 500 ms, 8 s; the PES with content in [3 s, 3.5 s) left out on video and AAC (holes of 520 and 512 ms, the next PES of both at 3.52 s), the teletext going on; no marker |
| `syn-gap-marker.ts`, `syn-gap-marker.bus.jsonl` | `fixture_gen --ts gap-marker` | The same hole with an OQ-12 gap marker on 0x100 (520 ms) and on 0x102 (512 ms), each right before its PID's first PES after the hole, and the recording's sidecar: 410 bus buffers of at most 7 packets stamped by `IdentityStamp` at their send time, each marker a buffer of its own flagged GAP|DISCONT (2112), PTS the hole's end (house 1003.52 s), no DTS (B-19) |
| `syn-video-hole-1s.ts` | `fixture_gen --ts video-hole-1s` | H.264 (the PCR) under +-4 ms PTS jitter beside continuous AAC, 11 s: video frames missing 1, 2 and 5 at a time (three times each), then 30, a 1.2 s hole at 8 s: B-89's video bound |
| `syn-private-novdesc.ts` | `fixture_gen --ts private-novdesc` | AAC on 0x102 (the PCR) beside three streams no demux row names: 0x06 without a descriptor (0x104, a PES every 100 ms), 0x86 carrying only SCTE-35 splice_null sections (0x105, every 1 s; the dump counts each as `pesMalformed`) and 0x82 carrying DTS frames (0x106), 4 s |
| `syn-pmt-version-bump.ts` | `fixture_gen --ts pmt-version-bump` | H.264 on 0x100 (the PCR) and AAC on 0x101, 8 s: PMT version 0; at 2 s version 1 with the same streams; at 4 s version 2 with 0x100 as HEVC (what is sent from then is HEVC, an IRAP first, libx265's parameter sets); at 6 s version 3 with the PCR on 0x101 |
| `syn-adts-mpeg2.ts` | `fixture_gen --ts adts-mpeg2` | AAC ADTS with the ID bit set (MPEG-2 AAC) on 0x101, the PCR there, 4 s |
| `syn-foreign-clock-aac.ts` | `fixture_gen --respace 40 -i cap-mux-align7-aac-opus.ts` | That capture with every PES PTS/DTS and PCR at 1.00004 times its distance from the first PES (36 ticks by its end): AAC and Opus on a clock 40 ppm off the house's |
| `tp-mpeg2video-mp2.ts` | `tools/fixtures/gen-thirdparty.sh`: ffmpeg 5.1 on the dev Pi, testsrc2 640x360 and sine, 8 s, rebased onto house 1000 s (as every `tp-*`) | MPEG-2 video with B-frames (0x02) and MPEG-1 Layer II audio (0x03) |
| `tp-h264-ac3-eac3.ts` | the same | H.264 with B-frames, AC-3 (0x81, registration AC-3) and E-AC-3 (0x87, registration EAC3) |
| `tp-h264-ac3-eac3-system-b.ts` | the same, `-mpegts_flags system_b` | AC-3 and E-AC-3 as 0x06 with descriptors 0x6A and 0x7A; ffmpeg fills the AC-3 descriptor in once it has seen the stream, so a second PMT follows at version 0 |
| `tp-h264-latm.ts` | the same, `-mpegts_flags latm` | AAC in LATM/LOAS (0x11) |
| `tp-hevc-aac.ts` | the same, libx265 | HEVC with B-frames (0x24, registration HEVC) and AAC |
| `tp-h264-dvbsub.ts` | the same; the subtitles from GStreamer's dvbsubenc (textrender), muxed by ffmpeg's stream copy | DVB subtitles (0x06 with the subtitling descriptor 0x59, language und): three cues and their clears. ffmpeg's own dvbsub decoder refuses that encoder's odd-height bitmaps, so it cannot re-encode them |
| `tp-h264-dts.ts` | the same, ffmpeg's dca encoder | DTS (0x82), a stream type no demux row names |
| `tp-opus-51.ts` | the same, libopus, mapping family 1 | Opus 5.1 (0x06, registration Opus, the 0x7F extension descriptor with channel configuration 6) |
| `tp-id3.ts` | the same script, GStreamer: AAC and timed `meta/x-id3` into mpegtsmux | ID3 on 0x15 with the metadata descriptor (and the metadata pointer in program_info): one ID3v2.4 TXXX tag a second on private_stream_1. ffprobe reads such a PES as a metadata AU cell and drops its first 5 bytes; the dump keeps the tag whole, as HLS readers do |
| `cap-gate-mux-hevc-aac-opus.ts` | A recording of the gate's 20040 rendition (2026-10-15), `tools/fixtures/trim.sh` from the PAT before its first IRAP, 10,638 packets | HEVC 720p50 with B-frames (DTS), AAC on two PIDs (language nor, eng) and Opus (swa) beside them. The recording is an ffmpeg `-c copy` capture (SDT FFmpeg, PTS from 1.4 s): the framing is libavformat's around the gate's streams, not our muxer's |
| `cap-mixer-302m-house.ts` | The audio-mixer's egress on the Pi 4 test box (ivan-test-p4) on 2026-10-24, bus tap; `trim.sh` from its first PAT, 10,638 packets | SMPTE 302M 16-bit stereo (BSSD) on house PES, one PES per 10 ms buffer; the trim cuts the last PES |
| `restamp/trace-vmix-sparse-pcr.stct` | The same vMix, session B's trace from the Phase 1 restamp on .103, 2026-10-21 (B-85): its first 856 s (2 MB) of 930 s | A sparse, steady PCR (one per IDR, every 2 s): since B-86 the PCR lock acquires in 74 s, never degraded, no warning, cadence 2.0 s, no PCR flagged, no clamp, relock, gap or drop (before: degraded (cadence) at 1.56 s for good, the switch to the regenerated PCR flagged). Not #820 (vMix in CBR mode, a PCR that stops and lags), which is still to be recorded |
| `restamp/trace-tech01-relay.stct` | The production gate's renditions as TECH01 relays them (TECH01's SRT listener), pulled by a standalone srtsrc caller (latency 600 ms) into the wf11 build's restamp on .108, 2026-10-22 (B-90): its first 734 s (2 MB) of 930 s | A 125 ms mux lead (PTS - PCR) on a bursty path that repeats every 150 s (a 12 s rise 400-600 ms above the floor, then 10 s on it): never degraded; locked at 308 s, the first fit on the full window's densest band (B-100; before it 188 s by the luck of the first bucket), the rate -36 -> -61 ppm with no warning (B-100's KEEP; without it the relock epoch's chained fit took it to -181 ppm); the PCR lock's envelope step at 315 s seeds its line on a rise and the window rule holds it at the bursts' height, so 1 relock and the start burst's 0.08 s dropped (B-95; before B-100 the two steps at 197 and 246 s; before B-95 the 150 s pairs, each one move onto the floor, 560-620 ms dropped per PID, 10 relocks and 4.75 s). Before B-90 (the lower bound on the lead against arrival): degraded (lead) at 91.4 s for good |
| `restamp/trace-tech01-relay-ahead-3400ms` (derived, no trace committed) | `fixture_gen --shift 0x64:3400 -i trace-tech01-relay.stct` (B-95) | TECH01's video PID 3.4 s further ahead, within the held excess of the 4 s lead bound: the stale clause's mark yields the window rule to the backlog rule for the whole line; since B-100 (the lock at 308 s, the step at 315 s) the yield shows as one more step relock (716 s) and video's stale runs, 1.57 s in 27 overlaps (2 relocks; without the yield 1 relock and 0.88 s), no longer the 150 s pairs (10 relocks, 10.5 s dropped before B-100) |
| `restamp/trace-tech01-relay-no-first-fit.stct` | TECH01's relay again, pulled from the Pi 4 test box by a standalone srtsrc caller (latency 600 ms) into the wf12 build's restamp, 2026-10-22 20:33:39Z, beside the engine's own caller (B-99): the first 83,332 records (1,999,984 B, 732 s) of the 60 min recording, cut on a whole buffer through `mrts_cli trace2jsonl` and `jsonl2trace` | The same delivery from a start whose first bucket lies in a rise: the level it opened holds 12 of the first 300 buckets, so before B-100 the clock stayed Acquiring for all 732 s (live, that recorder locked at 1174 s); since B-100 the first fit is made on the full window's densest band: locked at 308 s at +8.4 ppm, one envelope-step relock at 315 s, 1.09 s of gaps, nothing dropped |
| `restamp/trace-tech01-relay-freeze-runs.stct` | The same 60 min recording: its records from 2590 s to 3320 s after the first non-PSI record (83,151 records, 1,995,640 B, 730 s), the PSI records re-stamped at the first kept one, through `mrts_cli trace2jsonl` and `jsonl2trace` (B-101) | The stretch with the hour's three freeze degrades: under the old freeze test (the PCR advancing less than half a 30 ms pair's arrival span) its single 60 ms PCRs after 120-340 ms gaps were frozen pairs (599 in the cut), three in a row at 262.8, 412.7 and 712.8 s, each degrading the program (before B-100 the third for good; with B-100 alone the first held until 567.9 s while the relocked lock waited its window); since B-101 none is frozen: 0 degrades, locked at 308 s, 2 envelope-step relocks, 0.18 s dropped, +6.2 ppm |
| `restamp/trace-tech01-tall-burst-1600.stct` | Recording-derived (B-101): `fixture_gen --trace --duration 1800 --pcr-ms 60 --pids v,a2 --jitter-ms 0 --delay-ms 300 --ppm 0 --seed 3`, then every arrival moved by TECH01's recorded acyclic residual (the 60 min recording's PCR delay above its trend line, with its 150 s fold taken out and the 61 s slow part removed, sampled at the clean trace's arrival times from an offset chosen by seed 2) plus the recorded fold scaled to a 1.6 s main rise, arrivals kept in order; cut to its first 600 s (1,275,184 B), the PSI re-stamped at the first kept record. Committed: the residual is recorded data no generator reproduces | A taller burst whose tail runs below half speed for over 90 ms: the old freeze test degraded at 93.6 s (before B-100 for good, never locked), a span coupled to the cadence row's 500 ms at both bursts after the lock; since B-100 and B-101 locked at 306 s, one envelope-step relock at 314 s (B-95's step on the 1.6 s burst, 1.98 s dropped), 0 degrades, +12 ppm |
| `restamp/trace-tech01-relay-stuck-pcr` (derived, no trace committed) | `fixture_gen --freeze-pcr 0:0 -i trace-tech01-relay.stct` (B-101: every PCR arriving in [T, T+LEN) s after the trace's first record carries the first such PCR's value, LEN 0 to the end; arrivals and PES unchanged) | A PCR stuck from its first value, no cadence ever learned: degraded (freeze) at the third pair 0.26 s after the first record, as before B-101, never recovered; the degraded output runs on the reference lock's own 300 s window (B-100): its first envelope-step relock at 314 s (before B-100 by luck at 159.1 s) |
| `restamp/syn-step-dip` (generated, as every `syn-*` below) | `fixture_gen --trace`, TECH01's shape at a 60 ms PCR (B-95) | One envelope-step relock, the bursts' dips held, nothing dropped |
| `restamp/syn-step-genuine-fall` | a +600 ms queue in three steps, drained at 250 s (B-95) | The drain's floor moved onto 300 s after its last high run (554.7 s), once per PID |
| `restamp/syn-step-high-lead-drain` | as `syn-step-genuine-fall`, video 2.9 s ahead (B-95) | The yield: the move 2 s after the drain, as before B-95, never degraded |
| `restamp/syn-step-sparse-pcr` | ramped +700 ms bursts every 170 s at a 2 s PCR, 1100 s (B-95) | One relock, nothing dropped: the window counts house time, not buckets |
| `restamp/syn-step-sparse-pcr-jump`, `-jump-1s` | one step held, then the timeline 1 s (0.8 s) forward at a 2 s (1 s) PCR (B-95) | A leap relock as before B-95: no hole, nothing dropped |
| `restamp/syn-step-held-line-jump`, `-di` | TECH01's shape at a 60 ms PCR, the timeline 1 s forward at 600 s, unflagged and flagged (B-95) | The leap or discontinuity relock drops the held excess once per PID (360 / 363 ms), then the next burst steps again |
| `restamp/syn-step-drain-spikes` | a drained queue, then 3 s spikes every 60 s, 900 s (B-95) | The drain's floor moved onto at 702.9 s: L* ignores a spike shorter than a run |
| `restamp/syn-step-clamp-burst` | TECH01's shape with the AAC PID 4.5 s ahead (degraded, clamped) (B-95) | The reference and clamp locks' step lines held too: one relock, 5.5 s dropped (the entry's and the clamp's) |
| `restamp/syn-bursty-cycle-150`, `-60`, `-300`, `syn-bursty-flat` | `fixture_gen --trace --scatter-ms 200` (per second sent a delivery level in 0-200 ms from the seed, as a bursty relay scatters its 1 s minima), TECH01's shape every 150, 60 or 300 s or none, +50 ppm, 1200 s (B-100) | The first fit waits for the full 300 s window: locked at 306-308 s, the rate within the 100 ppm bound but not the clock's (the band reads the floor); before B-100 lucky locks at 152-270 s, the 300 s cycle's relock epoch taking the rate to -160 ppm |
| `restamp/syn-sparse-bursty` | `fixture_gen --trace --pcr-ms 2000 --scatter-ms 200`, +50 ppm, 600 s (B-100) | One bucket per 2 s PCR: the window is 300 s of house time, so the lock comes at 308 s (a window of 300 buckets would wait 600 s) |
| `restamp/syn-skew-floor-edge` | `fixture_gen --trace --scatter-ms 50:250 --scatter-floor 40` (40 % of the seconds on the floor, the rest 50-250 ms above), -50 ppm, 600 s (B-100) | The band reads the clock where the floor has a dense edge: +49.5 ppm at 306 s, pinned to 45-55 |
| `restamp/syn-offset-masked` | as `syn-bursty-cycle-150` with the source +100 ppm, 600 s (B-100) | The known limit, pinned on purpose: on a diffuse scatter the band reads about zero whatever the clock (-12.7 ppm where the truth is -100), the 'Source clock off' alarm silent |
