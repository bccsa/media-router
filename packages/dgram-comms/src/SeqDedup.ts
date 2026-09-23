/**
 * Receive-side sequence dedup, keyed by (sending session, seq).
 *
 * The sender stamps every data envelope with a seq that is monotonic per
 * SESSION (server: per Socket; client: per Client, shared across its paths)
 * and puts its session's socketID in the payload. Bonded multi-path copies
 * and retransmits carry the same (socketID, seq); genuinely distinct
 * messages never do. Keying on the socketID too means a reborn peer (new
 * session, seq restarting at 1) is never mistaken for a replay.
 *
 * One instance may be shared by several receiving Sockets — the multi-path
 * Client hands one to every path Socket so a copy that lands on path B is
 * dropped when path A already delivered it.
 */
export class SeqDedup {
    /** Delivered key → timestamp (ms); evicted by age. */
    private seen = new Map<string, number>();
    /** Age bound — must outlast the sender's ~13s fallback-resend window. */
    private readonly ttlMs: number;
    /** Hard backstop; age eviction is the primary bound. */
    private readonly maxEntries: number;

    constructor(ttlMs = 30000, maxEntries = 65536) {
        this.ttlMs = ttlMs;
        this.maxEntries = maxEntries;
    }

    /** True if this (session, seq) was already delivered; records it otherwise. */
    isDuplicate(sessionId: string | undefined, seq: number): boolean {
        const key = `${sessionId ?? ''}:${seq}`;
        if (this.seen.has(key)) return true;
        const now = Date.now();
        this.seen.set(key, now);
        // Insertion order is time order, so the oldest is always at the front.
        while (this.seen.size > 0) {
            const oldest = this.seen.keys().next().value as string;
            const ts = this.seen.get(oldest) ?? 0;
            if (this.seen.size <= this.maxEntries && now - ts <= this.ttlMs) break;
            this.seen.delete(oldest);
        }
        return false;
    }

    get size(): number {
        return this.seen.size;
    }

    clear(): void {
        this.seen.clear();
    }
}
