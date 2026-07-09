import { createLogger } from '@media-router/shared-types';

const log = createLogger('UdpPortManager');

const UDP_PORT_MIN = 40000;
const UDP_PORT_MAX = 50000;

/**
 * Simple UDP port allocator.
 *
 * Any module or service can request a port by owner ID.
 * Ports are unique and freed when released.
 */
export class UdpPortManager {
    /** owner → port */
    private allocated = new Map<string, number>();
    /** port → owner (reverse lookup for conflict detection) */
    private used = new Map<number, string>();
    /**
     * owner → port held before the last release, preferred on re-acquire so a
     * module restart lands back on its previous ports. Consumers have those
     * ports baked into their running udpsrc pipelines and get no restart when
     * a producer bounces, so a shifted allocation would silently feed them a
     * different stream. The mpegts consumer-restart cascade documents and
     * relies on this stickiness (see `MediaRouter.invalidateOutgoingPwLinks`).
     */
    private lastHeld = new Map<string, number>();
    /**
     * port → owner holding a `lastHeld` claim on it. Fresh allocations skip
     * claimed ports (first pass) so a NEW owner key appearing during a rebuild
     * — e.g. a newly discovered PID that sorts before existing streams —
     * cannot steal a released port out from under its returning owner. Claims
     * are surrendered under pool pressure rather than failing the allocation.
     */
    private reserved = new Map<number, string>();

    constructor(
        private readonly portMin: number = UDP_PORT_MIN,
        private readonly portMax: number = UDP_PORT_MAX,
    ) {}

    /** Request a port for an owner. Returns the same port if already allocated,
     *  else the owner's previous port when still free, else the lowest free
     *  port that no other owner holds a sticky claim on. */
    acquire(ownerId: string): number | null {
        const existing = this.allocated.get(ownerId);
        if (existing !== undefined) return existing;

        const previous = this.lastHeld.get(ownerId);
        if (previous !== undefined && !this.used.has(previous)) {
            this.allocated.set(ownerId, previous);
            this.used.set(previous, ownerId);
            log.info({ ownerId, port: previous }, 'Re-allocated previous port');
            return previous;
        }

        for (const allowReserved of [false, true]) {
            for (let p = this.portMin; p <= this.portMax; p++) {
                if (this.used.has(p)) continue;
                const claimant = this.reserved.get(p);
                if (!allowReserved && claimant !== undefined && claimant !== ownerId) continue;
                if (claimant !== undefined && claimant !== ownerId) {
                    // Pool pressure: evict the stale claim so its owner doesn't
                    // sticky-reclaim a port now carrying someone else's stream.
                    this.lastHeld.delete(claimant);
                }
                const stale = this.lastHeld.get(ownerId);
                if (stale !== undefined && this.reserved.get(stale) === ownerId) {
                    this.reserved.delete(stale);
                }
                this.allocated.set(ownerId, p);
                this.used.set(p, ownerId);
                this.lastHeld.set(ownerId, p);
                this.reserved.set(p, ownerId);
                log.info({ ownerId, port: p }, 'Allocated port');
                return p;
            }
        }

        log.error({ ownerId }, 'No free UDP ports');
        return null;
    }

    /** Get the port for an owner (if allocated). */
    get(ownerId: string): number | undefined {
        return this.allocated.get(ownerId);
    }

    /** Release a port back to the pool. */
    release(ownerId: string): void {
        const port = this.allocated.get(ownerId);
        if (port !== undefined) {
            this.allocated.delete(ownerId);
            this.used.delete(port);
            log.info({ ownerId, port }, 'Released port');
        }
    }

    /**
     * Release every port owned by `ownerId` or any sub-key of the form
     * `${ownerId}:*`. Used when a module shuts down and may have allocated
     * both a primary and one-or-more sub-port slots (e.g. demuxer outputs).
     */
    releaseAllForOwner(ownerId: string): void {
        const prefix = `${ownerId}:`;
        const toRelease: string[] = [];
        for (const key of this.allocated.keys()) {
            if (key === ownerId || key.startsWith(prefix)) toRelease.push(key);
        }
        for (const key of toRelease) this.release(key);
    }

    /** Release all ports and forget every sticky claim (full reset). */
    releaseAll(): void {
        this.allocated.clear();
        this.used.clear();
        this.lastHeld.clear();
        this.reserved.clear();
    }
}
