/**
 * Byte ceilings for time-bounded GStreamer `queue`s on compressed streams
 * (ADR-0015).
 *
 * A time bound alone is only as good as the timestamps flowing through the
 * queue: `queue` measures its level as (running time of the newest buffer in)
 * − (running time of the last buffer out). If the stream's stamps stall or step
 * back, the level reads as near-empty forever and the queue grows at wire rate
 * with no drop and no back-pressure. A byte bound fires regardless of
 * timestamps, so every compressed-stream queue on the bus carries one next to
 * its time bound.
 *
 * Origin — WORKING HYPOTHESIS, not yet confirmed on a box: on gate01
 * (2026-09-06) five mpegts-muxers grew to 2.8 GB each at exactly their program
 * bitrate while their SRT callers looped on reach-PLAYING; the growth was
 * anonymous heap in the producer, consistent with buffers held in a queue
 * whose time bound had gone blind. The box rebooted before the retained pages
 * could be read, so which queue held them is unproven (see docs/TodoNotes.md).
 * The byte cap is correct either way: it is the bound the time bound lacks.
 *
 * Sizing: 64 Mbit/s worth of the queue's time bound, floored at 1 MiB so a
 * single large access unit never trips a short queue. That is far above any
 * stream this system carries (HEVC 4K ≈ 20 Mbit/s, 16-ch 302M ≈ 18 Mbit/s):
 * a healthy stream never touches it — it is a runaway stop, not a budget.
 *
 * Per-consumer cost to keep in mind: `unixfdsink` copies each bus buffer into
 * shared memory and holds that copy until the consumer releases it, and the
 * consumer releases only when its own ingress queue lets the buffer go. A
 * consumer whose ingress (5 s → 40 MB, `buildBusSrc`) is full therefore pins
 * up to 40 MB of shm on the producer side per edge — bounded, but larger than
 * the producer's own 4 MB edge queue.
 *
 * NOT for raw video (1080p50 I420 alone is ~1.2 Gbit/s): raw paths keep
 * `max-size-bytes=0`.
 *
 * Applied: the runner's per-consumer bus edge branch, `buildBusSrc` ingress,
 * the mpegts-muxer per-pad queues, srt-output's back-pressure queue. Still
 * time-only and worth converting: `buildTsUdpInput`'s jitter queue,
 * mpegts-ip-output / mpegts-ip-input back-pressure queues, the video-player's
 * compressed pre-decode queue, and the literal queues in audio-transcoder,
 * audio-decoder and n1-mixer-302m.
 */

/** 64 Mbit/s expressed as bytes per millisecond. Mirrored by
 *  `BUS_EDGE_QUEUE_BYTES_PER_MS` in gst-pipeline-runner.py. */
export const TS_QUEUE_BYTES_PER_MS = 8_000;

/** Byte cap for a compressed-stream queue bounded to `bufferMs`. */
export function tsQueueByteCap(bufferMs: number): number {
    return Math.max(1_048_576, Math.round(bufferMs * TS_QUEUE_BYTES_PER_MS));
}
