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

    /** Request a port for an owner. Returns the same port if already allocated. */
    acquire(ownerId: string): number | null {
        const existing = this.allocated.get(ownerId);
        if (existing !== undefined) return existing;

        // Find next free port
        for (let p = UDP_PORT_MIN; p <= UDP_PORT_MAX; p++) {
            if (!this.used.has(p)) {
                this.allocated.set(ownerId, p);
                this.used.set(p, ownerId);
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

    /** Release all ports. */
    releaseAll(): void {
        this.allocated.clear();
        this.used.clear();
    }
}
