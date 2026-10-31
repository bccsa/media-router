/**
 * A module's PipeWire stream lost under it (B-195): what it says while down and when it may be
 * rebuilt. A PipeWire restart, a failed or silent stream all end the same way: the device
 * watchdog tears the pipeline down and rebuilds it once PipeWire and the device are back.
 */

/** The cause named when the PipeWire daemon itself changed under the module. */
export const PIPEWIRE_RESTARTED = 'PipeWire restarted';
/** The cause named when pactl gets no answer at the moment of the loss. */
export const PIPEWIRE_NOT_ANSWERING = 'PipeWire is not answering';

/** A rebuilt stream that runs this long ends a run of losses: the next one rebuilds at once. */
export const REBUILD_STABLE_MS = 60_000;
/** The wait before the second rebuild of a run; it doubles per loss up to the cap. */
export const REBUILD_BACKOFF_BASE_MS = 2_000;
export const REBUILD_BACKOFF_MAX_MS = 60_000;

/** No audio buffers this long from a PLAYING capture is a dead stream; silence still flows. */
export const PIPEWIRE_CAPTURE_STALL_MS = 4_000;

/** How long a rebuild waits after loss number `attempt` of a run (the first: not at all). */
export function rebuildDelayMs(attempt: number): number {
    if (attempt <= 1) return 0;
    return Math.min(REBUILD_BACKOFF_BASE_MS * 2 ** (attempt - 2), REBUILD_BACKOFF_MAX_MS);
}

/** The health warning while the stream is down. */
export function lossWarning(cause: string, delayMs: number): string {
    return delayMs > 0
        ? `${cause} — rebuilding the stream in ${Math.ceil(delayMs / 1000)} s`
        : `${cause} — rebuilding the stream once PipeWire and the device are back`;
}
