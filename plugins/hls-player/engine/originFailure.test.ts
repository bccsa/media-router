import { describe, it, expect } from 'vitest';
import {
    classifyOriginFailure,
    originFailureMessage,
    FETCH_FAIL_THRESHOLD,
} from './originFailure.js';

describe('classifyOriginFailure', () => {
    it('reads a refused origin (401/403) as an auth failure', () => {
        // Exactly what NodeLoader throws and the runner prints on stderr.
        expect(
            classifyOriginFailure('hls-pipe error: HTTP 403 for https://cdn.x/seg1.ts?token=a'),
        ).toEqual({ kind: 'auth', status: 403, detail: 'HTTP 403' });
        expect(classifyOriginFailure('HTTP 401 for https://cdn.x/master.m3u8')).toEqual({
            kind: 'auth',
            status: 401,
            detail: 'HTTP 401',
        });
    });

    it('keeps other HTTP statuses in the generic bucket, with the status quoted', () => {
        expect(classifyOriginFailure('HTTP 404 for https://cdn.x/seg9.ts')).toEqual({
            kind: 'fetch',
            status: 404,
            detail: 'HTTP 404',
        });
        expect(classifyOriginFailure('HTTP 503 for https://cdn.x/seg9.ts')).toMatchObject({
            kind: 'fetch',
            status: 503,
        });
    });

    it('recognises the network-level failures fetch reports without a status', () => {
        expect(classifyOriginFailure('hls-pipe error: fetch failed')).toEqual({
            kind: 'fetch',
            detail: 'fetch failed',
        });
        expect(classifyOriginFailure('getaddrinfo ENOTFOUND cdn.example.com')).toMatchObject({
            kind: 'fetch',
            detail: 'ENOTFOUND',
        });
        expect(classifyOriginFailure('connect ECONNREFUSED 10.0.0.5:443')).toMatchObject({
            kind: 'fetch',
        });
        expect(classifyOriginFailure('hls-pipe error: timeout 20000ms')).toMatchObject({
            kind: 'fetch',
            detail: 'timeout 20000ms',
        });
    });

    it('ignores ordinary runner chatter — a false positive would red-flag a healthy card', () => {
        expect(classifyOriginFailure('fetching manifest: https://cdn.x/master.m3u8')).toBeNull();
        expect(classifyOriginFailure('abandon: retrying seq=42 at level 1')).toBeNull();
        // The `unstable` ABR preset talks about the network; it is not a fault.
        expect(classifyOriginFailure('abr: unstable network preset active')).toBeNull();
        expect(classifyOriginFailure('live: waiting 3000ms for new segments')).toBeNull();
        expect(classifyOriginFailure('')).toBeNull();
    });
});

describe('originFailureMessage', () => {
    it('names the expired signature for a 403 — the field’s actual failure', () => {
        expect(originFailureMessage({ kind: 'auth', status: 403, detail: 'HTTP 403' }, 0)).toBe(
            'HLS origin rejecting requests (HTTP 403) — signed URL likely expired',
        );
    });

    it('distinguishes 401 — credentials, not a lapsed token', () => {
        const msg = originFailureMessage({ kind: 'auth', status: 401, detail: 'HTTP 401' }, 0)!;
        expect(msg).toContain('HTTP 401');
        expect(msg).toContain('credentials');
        expect(msg).not.toContain('signed URL');
    });

    it('reports auth on the first occurrence — retrying cannot change the answer', () => {
        expect(
            originFailureMessage({ kind: 'auth', status: 403, detail: 'HTTP 403' }, 1),
        ).not.toBeNull();
    });

    it('stays quiet for a fetch blip and speaks up at the threshold', () => {
        const blip = { kind: 'fetch', detail: 'fetch failed' } as const;
        for (let n = 1; n < FETCH_FAIL_THRESHOLD; n++) {
            expect(originFailureMessage(blip, n)).toBeNull();
        }
        expect(originFailureMessage(blip, FETCH_FAIL_THRESHOLD)).toBe(
            'HLS fetch failing repeatedly (3× fetch failed) — check the URL, origin and network',
        );
    });

    it('quotes the evidence, so an HTTP outage does not read as a dead link', () => {
        expect(originFailureMessage({ kind: 'fetch', status: 404, detail: 'HTTP 404' }, 4)).toBe(
            'HLS fetch failing repeatedly (4× HTTP 404) — check the URL, origin and network',
        );
    });
});
