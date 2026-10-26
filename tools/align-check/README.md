# align-check — the house-clock gate tools

The tools the device rounds of the house-clock plan use to judge timing on a box's recordings
(chapter 6 WI-P2-16 named them, chapter 7 WI-P3-20 added the formula check; built in Phase 3,
WI-P3-3, register B-120). They run on the dev Pi on files copied back from a box; nothing here
ships. Recordings come from `tools/fixtures/record-bus.sh`, which records a bus edge on a box
(`/tmp/mr-bus-<port>-<suffix>.sock`, see `tools/avskew/README.md` for finding an edge's socket)
into `<name>.ts` and its sidecar `<name>.bus.jsonl`, and with `--demux` the box's own
`mrtsdemux` output as `<name>.pads.jsonl`. `tests/align_check_test.py` tests all three on
the committed fixtures (mpegts-core's `test:py`).

Requirements: `mrts_cli` built (`make native`), gawk (the dev Pi's awk), and numpy for
`pcm_align.py`. `MRTS_CLI` overrides the CLI's path.

## Tools and their pass criteria

| Tool | What it does | Passes when |
|---|---|---|
| `pes_diff.sh a.ts b.ts [--by crc32\|pts] [--map A:B] [--tol N] [--lines]` | Joins two captures of one stream, `a` before a hop and `b` after it, PES for PES per PID (`--map` pairs other PIDs), and reports `b - a` of PTS and DTS in 90 kHz ticks, folded across 2^33. `--by crc32` (default) joins equal payloads, for a hop that passes access units through; `--by pts` joins by PTS order, nearest within half the PID's spacing, for a re-encode whose payloads differ | every joined delta is within `--tol` (0) and no PES inside both captures' span lacks a partner. V1: a transcoder's egress against its input, 0 ticks every AU (`--by pts` for the re-encoded video); the audio-transcoder's AAC AU for AU within 1 tick (`--tol 1`), Opus 0 (S40). V2: a muxer's egress against its inputs, per PID, 0 ticks |
| `pes_formula.sh <stem>` | The formula on the box: each buffer of `<stem>.pads.jsonl` (record-bus `--demux`) joined with its PES in `mrts_cli dump <stem>.ts`, by its pad's PID (select mode's `src`: any) and the next PES in stream order with its crc32 and length | every buffer joined, its PTS `ceil((PES PTS - 1 h, unwrapped) x 100000 / 9)` ns exactly (S12), its DTS the same of the PES DTS. It also counts the buffers on Phase 2's floor (`floor`), so a box still on a Phase 2 native set shows as `exact 0, floor n, maxDevNs -1`. V1, V2, V10 (across the wrap: the unwrap is the box's, the check takes the buffer's 2^33 period) |
| `pcm_align.py a b [--want-offset N] [--max-fill PCT] [--window S] [--max-lag MS] [--channel N] [--pid PID]` | Two captures of one programme, SMPTE 302M in a `.ts` (decoded here PES by PES, as ffmpeg's decoder does, and placed at its PTS on the house timeline) or a `.wav` (from its first sample): the offset of b's content against a's in samples (cross-correlation over `--window` from the overlap's start), and the silence fill, the share of a's sounding samples where b is digital silence or missing | `offsetSamples` is the expected offset (`--want-offset`, 0 for one programme on one timeline) and `fillPct` is at most `--max-fill` (0). V6 (aes67-output and the 302M fan-in), V7, and Phase 2's silence-fill and programme-offset checks |

Each prints JSON lines, one per PID pair, pad or comparison, then a summary with `pass`, and
exits 0 on a pass, 1 on a failure, 2 on unusable input. `pes_diff.sh --lines` adds a line per
joined pair (`dPts`, `dDts`): the per-AU listing V1 asks for.

## Notes

- The PES PTS in a dump is the 33-bit wire value; house time is `PES - 1 h` (the bus formula).
  `pes_diff.sh` compares wire values, so a constant shift between the two (a rebase, a restamp)
  shows as that constant on every PES.
- A recording started mid-PES, or cut by the trim, ends or starts with a PES the dump counts
  `pesMalformed`; the join tools skip it.
- The audio-transcoder re-encodes: its AAC PTS follow the encoder's sample ladder from the first
  AU and may sit a tick low after the mux's floor (S40), so V1 holds it to `--tol 1`; the first
  AU must be exact, which `--lines` shows.
- The 302M decode reads 16, 20 and 24-bit 302M (`tests/align_check_test.py` pins the 24-bit fixture
  to ffmpeg's decode); a capture with PES holes (an ASRC's relock, a lost PES) shows them as
  `holesA`/`holesB`, and b's holes count as fill.
