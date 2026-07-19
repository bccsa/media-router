import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DnsCache } from './dnsCache.js';

type LookupCb = (err: NodeJS.ErrnoException | null, address: string) => void;

/** A controllable dns.lookup stand-in: calls are captured, answered manually. */
function fakeLookup() {
    const pending: Array<{ hostname: string; cb: LookupCb }> = [];
    const fn = vi.fn((hostname: string, _opts: { family: number }, cb: LookupCb) => {
        pending.push({ hostname, cb });
    });
    return { fn, pending };
}

describe('DnsCache', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('returns IP literals as-is without ever looking them up', () => {
        const { fn } = fakeLookup();
        const cache = new DnsCache(60_000, fn);
        expect(cache.resolve('10.9.16.20')).toBe('10.9.16.20');
        expect(cache.resolve('::1')).toBe('::1');
        expect(fn).not.toHaveBeenCalled();
    });

    it('falls back to the hostname until the first lookup lands, then serves the IP', () => {
        const { fn, pending } = fakeLookup();
        const cache = new DnsCache(60_000, fn);

        expect(cache.resolve('mgr.example.com')).toBe('mgr.example.com');
        expect(fn).toHaveBeenCalledTimes(1);

        pending[0].cb(null, '102.215.133.130');
        expect(cache.resolve('mgr.example.com')).toBe('102.215.133.130');
        // Warm hit — no further lookups.
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('serves the stale IP during a TTL-expiry refresh (send path never blocks)', () => {
        const { fn, pending } = fakeLookup();
        const cache = new DnsCache(60_000, fn);
        cache.resolve('mgr.example.com');
        pending[0].cb(null, '102.215.133.130');

        vi.advanceTimersByTime(61_000);

        // Expired: still answers with the old IP, refresh kicked off behind it.
        expect(cache.resolve('mgr.example.com')).toBe('102.215.133.130');
        expect(fn).toHaveBeenCalledTimes(2);

        pending[1].cb(null, '102.215.133.131');
        expect(cache.resolve('mgr.example.com')).toBe('102.215.133.131');
    });

    it('keeps the last good IP when a refresh fails', () => {
        const { fn, pending } = fakeLookup();
        const cache = new DnsCache(60_000, fn);
        cache.resolve('mgr.example.com');
        pending[0].cb(null, '102.215.133.130');

        vi.advanceTimersByTime(61_000);
        cache.resolve('mgr.example.com');
        pending[1].cb(Object.assign(new Error('ETIMEOUT'), { code: 'ETIMEOUT' }), '');

        // Failure must not poison the endpoint we already know how to reach.
        expect(cache.resolve('mgr.example.com')).toBe('102.215.133.130');
    });

    it('coalesces concurrent resolves into a single in-flight lookup per host', () => {
        const { fn } = fakeLookup();
        const cache = new DnsCache(60_000, fn);
        for (let i = 0; i < 50; i++) cache.resolve('mgr.example.com');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('tracks distinct hosts independently', () => {
        const { fn, pending } = fakeLookup();
        const cache = new DnsCache(60_000, fn);
        cache.resolve('a.example.com');
        cache.resolve('b.example.com');
        pending[0].cb(null, '10.0.0.1');
        pending[1].cb(null, '10.0.0.2');
        expect(cache.resolve('a.example.com')).toBe('10.0.0.1');
        expect(cache.resolve('b.example.com')).toBe('10.0.0.2');
    });

    it('clear() forgets cached entries and allows a fresh lookup', () => {
        const { fn, pending } = fakeLookup();
        const cache = new DnsCache(60_000, fn);
        cache.resolve('mgr.example.com');
        pending[0].cb(null, '102.215.133.130');

        cache.clear();
        expect(cache.resolve('mgr.example.com')).toBe('mgr.example.com');
        expect(fn).toHaveBeenCalledTimes(2);
    });
});
