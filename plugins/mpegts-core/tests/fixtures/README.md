# Conformance fixtures

`<name>.ts` with `<name>.expect.jsonl`, its `mrts_cli dump` (and `<name>.p<N>.expect.jsonl`,
the dump following program N), replayed by `native/mrts/tests/ts_conformance_test` at 188,
1316 and 24 576-byte chunks (plan ch. 3 part 7.2, WI-S0-9). A changed expectation is
regenerated with `mrts_cli dump <name>.ts > <name>.expect.jsonl` and reviewed against
`tests/dump_vs_ffprobe.py` before it is committed. None of this ships (WI-S0-13).
Arrival traces for the restamp are in `restamp/` (ch. 5 part 7.2, WI-P1-5); each
`.expect.json` there says how its trace was recorded.

| Fixture | Source (recorded 2026-10-16 unless dated) | What it holds |
|---|---|---|
| `syn-mpts-two-programs.ts` | `fixture_gen --ts mpts-two-programs` | The parity stream's program 1 (sparse PSI, PCR jitter, Opus, KLV, CC gaps, desync garbage, AVC → HEVC: PMT generation 2) and a second program (H.264 with DTS, MPEG-1 audio) in one PAT |
| `syn-wrap-33bit.ts` | `fixture_gen --ts wrap-33bit` (trace_gen's model, `--wrap-at 5`) | PTS, DTS and PCR across 2^33, B-frame DTS behind PTS at the wrap, teletext |
| `syn-pes-header-split.ts` | `fixture_gen --ts pes-header-split` | Video PES headers cut after 1 to 18 bytes by the PUSI packet's adaptation field, an AAC PES between the halves |
| `syn-pes-no-pts.ts` | `fixture_gen --ts pes-no-pts` | PES without PTS; padding (0xBE) and private_stream_2 (0xBF) |
| `syn-source-restart.ts` | `fixture_gen --ts source-restart` | A +3 h timeline jump at 3 s, `discontinuity_indicator` on the first PCR after, every CC from 0 |
| `cap-occ-1080i-h264-aac-ttx.ts` | The OCC multicast capture of 2026-07-17 (`occ-capture-20260717.ts`), from the PAT before the first IDR after 3 s, PIDs 0, 0x64, 0x65, 0xc9, 0xcc and 0x20 kept | 1080i H.264 with B-frames (an IDR of 442 KB), AAC ADTS, teletext, the 514-byte PMT |
| `cap-occ-1080i-h264-mp2-ttx.ts` | The same capture's first 10,638 packets from offset 0, every PID kept (WI-P2-4, plan ch. 15.4 B-54; the drafted name, though the audio is AAC) | 1080i H.264 on the PCR PID 0x65, 22 AAC PIDs, teletext on 0x20, the 514-byte PMT about 450 packets before each PAT, so the dump starts at the PMT after the first PAT (B-13); the splitter pass-through tests and `scn-split-passthrough` use it |
| `cap-mux-unbounded-video.ts` | Our mpegts-muxer remuxing the OCC replay's H.264 and AAC on 10.9.16.103, bus tap | Unbounded and bounded video PES (> 64 KB written with length 0), DTS on B-frames, `alignment=7` |
| `cap-mux-align7-aac-opus.ts` | Our mpegts-muxer muxing AAC (gate 20010 via the splitter) and Opus (an audio-transcoder) on .103, bus tap, 10 s | Several PES starts per 1316 bytes, PSI between them, bounded audio PES, the Opus registration |
| `cap-cc-loss.ts` | `cap-mux-align7-aac-opus.ts` with packets removed by `fixture_gen --drop` (the list is in the test) | CC loss mid-PES, a lost PES start, two packets in a row, a lost PMT packet |
| `cap-302m-bssd.ts` | audio-input-302m on 10.9.16.108 (KT USB capture, `mrasrc`, fixed restamp), bus tap | SMPTE 302M with the `BSSD` registration, one PES per buffer, no DTS |
| `cap-klv-sparse.ts` | teletext-subtitles page 888 on .103, bus tap, 180 s | KLVA private stream (0xBD), PTS on the bus timeline |
| `cap-srt-ingest-1316.ts` | srt-input on .108 from ffmpeg's mpegts muxer (libx264 CBR, AAC, muxrate 3 Mbit/s) over SRT, the srtsrc output itself, 1519 datagrams | A third-party mux in 1316-byte datagrams, at most one PCR per datagram |
