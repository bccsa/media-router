/**
 * When the muxer's `mpegtsmux` (a GstAggregator) emits, how much of each PES
 * it keeps back and how often it writes a PCR — its `latency`,
 * `min-upstream-latency`, `alignment` and `pcr-interval`.
 *
 * UNDER THE TIME-SYNC CONTRACT (ADR-0005) the muxer waits for nothing:
 * `latency=0 alignment=0 pcr-interval=1800`.
 *
 * - No budget. Every input buffer's running time IS its producer's house stamp
 *   (base_time 0, branches anchored by `alignBranchesToStamps`) and it arrives
 *   after that stamp, so the aggregator's deadline (running time + latency) has
 *   always passed: each buffer is muxed the moment it arrives, and a lagging
 *   input holds nobody back. Any budget the lateness fits in instead makes
 *   the aggregator wait until EVERY pad has data and emit the earliest. That is
 *   lock-step, and each audio PES then waits for the next video frame with a
 *   later DTS, so muxed audio leaves with the encoder's lateness and jitter
 *   (.21 Mulanje, 2026-10-03: 96 % of the output buffers carrying audio also
 *   started a video PES; audio arrival jitter −67/+84 ms = the video's
 *   −82/+80 ms). A dark input froze the whole output for the same reason.
 * - `alignment=0`. With 7, the last partial 7-packet group of every PES waits
 *   for the next PES, and on a mux whose audio PES are 2–3 packets that next
 *   PES is again the video frame. The bus egress coalesces each push into one
 *   buffer and every wire output re-slices itself (ADR-0011), so nothing
 *   depends on the grouping. The encode leaves made the same move on 2026-09-04.
 * - `pcr-interval=1800` (20 ms): a PCR on every 25/30 fps video frame.
 *   mpegtsmux writes a PCR only on a packet of the PCR stream, once that
 *   stream's DTS is MORE than the interval past the last PCR, so its default
 *   (3600, 40 ms) skips every other 25 fps frame. Where latch repair is on
 *   (ADR-0005 Stage 3f), the egress conditioner rewrites each PCR as the
 *   lowest PTS lately written on any stream minus 250 ms. Muxed on arrival,
 *   that floor also follows the audio's bursts. On .21 (2026-10-05), 20 of
 *   2109 PCR steps then exceeded ISO 13818-1's 100 ms, up to 113.4 ms.
 *   Replaying .21's input timing, the largest step was 116.9 ms at 3600 and
 *   84.5 ms at 1800; on .21 at 1800 (2026-10-06), 0 of 3001 exceeded 100 ms
 *   (max 86.2 ms).
 *
 * Replica (gst 1.28.2, contract clock, 25 fps video arriving N(80, 48) ms
 * late, AAC on time): the audio hold through the mux fell from p50 110 /
 * p95 182 ms to p50 22 / p95 28 ms. The 22 ms left is the hook's `aacparse`
 * keeping one frame back, not the mux. The TS stays valid (per-PID DTS order,
 * no PTS<DTS, CC clean, every PES out). PCR stays on the video PID: on the
 * audio PID, every video frame more than 125 ms behind its audio arrived
 * after its PCR (44 PES in the replica, down to −88 ms).
 *
 * On .21 (2026-10-05, 120 s of SRT output each), audio PES sharing an SRT
 * payload with a video PES start fell from 95.7 % to 0 %. Lateness past the
 * stamp (p50/p95/max) fell from 96/132/164 to 68.5/103/138 ms for audio and
 * from 104/143/170 to 59/71/100 ms for video. There the audio arrives later
 * than the video, so lock-step had held the video as well.
 *
 * CONTRACT OFF (`MR_TIME_SYNC_CONTRACT=0`): byte-identical to before. That is
 * the 2026-07-16 budget (1.2 s plus the same as `min-upstream-latency`) and the
 * operator's `alignment`. There the bus carries arrival times, not house
 * stamps. As measured in the live muxer that July, the cross-process bus hid
 * ~1 s of upstream latency from the latency query, so with no budget the
 * deadline had always expired and upstream jitter reached the wire as
 * backward-DTS jolts and PTS<DTS audio PES.
 */

/** The 2026-07-16 legacy budget, ns (also its `min-upstream-latency`). */
const LEGACY_LATENCY_NS = 1_200_000_000;

/** Contract PCR interval, 90 kHz ticks (20 ms): a PCR on every 25/30 fps frame. */
const PCR_INTERVAL_TICKS = 1800;

/** `mpegtsmux` timing properties (`latency=… … alignment=…`, contract `pcr-interval`). */
export function muxTimingProps(timeSyncContract: boolean, alignment: number): string {
    if (timeSyncContract) return `latency=0 alignment=0 pcr-interval=${PCR_INTERVAL_TICKS}`;
    return (
        `latency=${LEGACY_LATENCY_NS} min-upstream-latency=${LEGACY_LATENCY_NS}` +
        ` alignment=${alignment}`
    );
}
