// An audio output's sink end (house-clock part 4.1, OQ-31; B-217, B-249): the ring of a `sync=false` sink, the
// margin its device-mode `mrasrc` keeps in that ring, and the queue between them.

/** `pulsesink buffer-time` (µs): the field's xrun floor (a 50 ms ring xrunned on a Pi 4). */
export const OUTPUT_RING_US = 100_000;

/** `mrasrc margin-ms` (B-249): a write the device can no longer play (a hole), or the first, lands this far
 *  ahead of it (twice at a start), so a feed may get this much later again without a hole. */
export const OUTPUT_MARGIN_MS = 60;

/** The queue's element name: the tests find it by it. */
export const OUTPUT_QUEUE_NAME = 'outq';

/** The non-leaky queue before an output's sink: its own thread, so a full ring blocks this queue and not the
 *  mix. No min-threshold: a threshold releases as it is fed, delay but no margin (B-249). */
export function buildOutputQueue(): string {
    return `queue name=${OUTPUT_QUEUE_NAME} leaky=0 max-size-time=1000000000 max-size-buffers=0 max-size-bytes=0`;
}
