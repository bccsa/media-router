// The audio outputs' sink end (house-clock part 4.1, OQ-31): one prefill and one ring for both
// (Audio Output 302M, Audio Decoder), each sink `sync=false` behind its device-mode `mrasrc`.

/** `pulsesink buffer-time` (µs): the field's xrun floor (a 50 ms ring xrunned on a Pi 4). */
export const OUTPUT_RING_US = 100_000;

/** What the prefill holds before its sink gets anything, and again once it drained (ms). */
export const OUTPUT_PREFILL_MS = 40;

/** The prefill's element name: the queue watch and the tests find it by it. */
export const OUTPUT_PREFILL_NAME = 'prefill';

/** The non-leaky prefill before an output's sink. A drained queue holds its delay again only on
 *  the image's patched queue (B-68); a backlog fills its 1 s before it waits upstream, and the
 *  drain reads that fill (B-179). */
export function buildOutputPrefill(): string {
    return (
        `queue name=${OUTPUT_PREFILL_NAME} leaky=0 min-threshold-time=${OUTPUT_PREFILL_MS * 1_000_000}` +
        ' max-size-time=1000000000 max-size-buffers=0 max-size-bytes=0'
    );
}
