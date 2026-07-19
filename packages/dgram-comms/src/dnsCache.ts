import { isIP } from 'net';
import * as dns from 'dns';

/** How long a resolved hostname stays usable before a background refresh. */
const DEFAULT_TTL_MS = 60_000;

type LookupFn = (
    hostname: string,
    options: { family: number },
    callback: (err: NodeJS.ErrnoException | null, address: string) => void,
) => void;

interface Entry {
    ip: string;
    expiresAt: number;
}

/**
 * Synchronous hostname→IP cache for the datagram send path.
 *
 * `dgram.send()` re-resolves a hostname on EVERY call, and each lookup occupies
 * one of libuv's 4 threadpool slots. At real send rates — keepalives, telemetry,
 * and one lookup per *fragment* of a multi-fragment push — the pool saturates
 * and datagrams queue behind DNS for tens of seconds (measured on NO-BR-Gate01
 * against a ~190ms resolver: sends landing 29s late, so every handshake timed
 * out before its packets ever left the box, while engines configured by bare IP
 * were unaffected).
 *
 * `resolve()` therefore never blocks and never awaits — it returns an address to
 * send to right now and refreshes in the background. A stale entry is served
 * while its refresh is in flight, so a TTL rollover costs zero latency, and a
 * failed lookup keeps the last good IP rather than poisoning the cache.
 */
export class DnsCache {
    private cache = new Map<string, Entry>();
    private inflight = new Set<string>();

    constructor(
        private readonly ttlMs = DEFAULT_TTL_MS,
        private readonly lookupFn: LookupFn = dns.lookup as LookupFn,
    ) {}

    /**
     * Address to hand to `udpSocket.send()` — an IP whenever one is known.
     * Falls back to the hostname only until the first lookup lands, where dgram
     * resolves that single packet itself exactly as it did before the cache.
     */
    resolve(host: string): string {
        if (isIP(host)) return host;

        const hit = this.cache.get(host);
        if (!hit) {
            this.refresh(host);
            return host;
        }
        if (Date.now() >= hit.expiresAt) this.refresh(host);
        return hit.ip;
    }

    /** One lookup per host at a time — a send burst must not become a DNS burst. */
    private refresh(host: string): void {
        if (this.inflight.has(host)) return;
        this.inflight.add(host);

        this.lookupFn(host, { family: 4 }, (err, address) => {
            this.inflight.delete(host);
            // Keep serving the previous IP on failure: a transient resolver blip
            // must not cost us an endpoint we already know how to reach.
            if (err || !address) return;
            this.cache.set(host, { ip: address, expiresAt: Date.now() + this.ttlMs });
        });
    }

    /** Drop everything cached (tests, and reconfiguration that repoints a host). */
    clear(): void {
        this.cache.clear();
        this.inflight.clear();
    }
}

/** Shared, so one hostname costs one lookup per TTL across every path and socket. */
export const dnsCache = new DnsCache();
