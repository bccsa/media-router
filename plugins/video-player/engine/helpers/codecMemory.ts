/**
 * What codec a bus source was last seen carrying, remembered for the engine
 * process.
 *
 * WHY. The player learns its codec from the live pipeline's own TS probe, so a
 * module that starts knowing nothing has to bootstrap on `decodebin3` — which
 * auto-plugs a HARDWARE decoder, opens the V4L2 device, and is torn down again
 * a second later when the probe reports and the explicit chain is built. That
 * open/kill cycle is cheap on paper and expensive in the field: it leaves the
 * Pi's stateless HEVC block dirty, which lengthens the NEXT session's device-open
 * stall — the stall whose leaky-queue shed is what feeds the decoder
 * missing-reference AUs in the first place. An external `moduleRestart` (the
 * manager's profile-patch path) paid that cycle every single time, for a codec
 * the engine had known since the previous start.
 *
 * WHY IT IS KEYED BY SOURCE, not just by instance. Forgetting the codec on an
 * external stop was deliberate: an external stop is where a REWIRE happens, and
 * building an explicit h265 chain for what is now an h264 feed is a guaranteed
 * error cycle. Keying the memory on the producer edge keeps that protection —
 * a rewire is a different key, so it bootstraps on `decodebin3` exactly as
 * before — while a restart against the SAME source starts on the right decoder.
 * The TS probe still runs on every live pipeline, so a codec CHANGE on an
 * unchanged edge is detected and rebuilt exactly as it is today; the memory only
 * ever decides where to START.
 *
 * THE ONE CASE THE KEY CANNOT COVER: the edge stays the same but the FEED
 * changes. An upstream encoder flipping h265→h264 stalls the TS first, so the
 * stall path (`forget`) is where that memory is dropped — a rewire changes the
 * key, but a reconfiguration does not. See VideoPlayerModule's `bus_stall`
 * handler.
 *
 * Key space is profile-bounded (module instance × producer edge), so the map
 * does not grow with time.
 */

/** The fields of a bus source that identify the producer edge. */
export interface CodecMemorySource {
    sourceModuleId?: string;
    sourcePortId?: string;
}

/**
 * Memory key for one consumer-instance/producer-edge pair, or `undefined` when
 * the source cannot be identified — an unidentifiable source must not share a
 * key with a different one, so it simply gets no memory.
 */
export function codecMemoryKey(
    instanceId: string | undefined,
    source: CodecMemorySource | undefined,
): string | undefined {
    if (!instanceId || !source?.sourceModuleId) return undefined;
    return `${instanceId}|${source.sourceModuleId}:${source.sourcePortId ?? ''}`;
}

export class CodecMemory {
    private readonly byKey = new Map<string, string>();

    /** Record what the probe just reported. No key = nothing to record against. */
    remember(key: string | undefined, codec: string): void {
        if (key) this.byKey.set(key, codec);
    }

    /** What this edge last carried, or `undefined` — i.e. "bootstrap". */
    recall(key: string | undefined): string | undefined {
        return key ? this.byKey.get(key) : undefined;
    }

    /**
     * Drop what we think we know about one edge, so the next build bootstraps.
     *
     * The caller is the stall path: a source that went silent for 5 s has most
     * likely been RECONFIGURED upstream (an encoder restarting on a different
     * codec is exactly how a feed goes quiet), so the remembered codec is the
     * one thing that is now suspect — see VideoPlayerModule's `bus_stall`
     * handler for why guessing costs more than bootstrapping here.
     */
    forget(key: string | undefined): void {
        if (key) this.byKey.delete(key);
    }

    clear(): void {
        this.byKey.clear();
    }
}
