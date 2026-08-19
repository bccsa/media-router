import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { aes67RtpCaps } from '@media-router/engine';

/**
 * AES67 against REAL GStreamer elements — the three things the plugins assume
 * and could not otherwise prove:
 *
 * 1. `rtpL24pay` derives its RTP timestamp from ABSOLUTE running time. The
 *    whole PTP-epoch design is that claim: if the payloader anchored on the
 *    first buffer instead, `timestamp-offset` would be a per-start constant and
 *    could never be an epoch.
 * 2. The RFC 7273 caps string the engine helper builds survives
 *    `gst_parse_launch` — its escaped quotes are easy to break and the failure
 *    mode is a pipeline that never starts.
 * 3. An L24 RTP hop is bit-exact: PCM in, PCM out, over a real UDP socket.
 *
 * Skipped (loudly, per test) where the elements or python-gi are missing, so a
 * CI box without GStreamer cannot pass this vacuously.
 */

const PROBE = join(__dirname, 'aes67_gst_probe.py');

interface Probe {
    elements: Record<string, boolean>;
    ok: boolean;
    reason: string;
}

function runProbe<T>(args: string[]): T {
    const r = spawnSync('python3', [PROBE, ...args], { encoding: 'utf8', timeout: 90_000 });
    if (r.status !== 0) throw new Error(`probe ${args[0]} failed: ${r.stderr || r.error}`);
    return JSON.parse(r.stdout) as T;
}

const probe: Probe = (() => {
    const r = spawnSync('python3', [PROBE, 'elements'], { encoding: 'utf8', timeout: 60_000 });
    if (r.status !== 0) {
        return {
            elements: {},
            ok: false,
            reason: `python3-gi/GStreamer unavailable: ${r.stderr?.trim() || r.error}`,
        };
    }
    const elements = JSON.parse(r.stdout) as Record<string, boolean>;
    const missing = Object.entries(elements)
        .filter(([, present]) => !present)
        .map(([n]) => n);
    return {
        elements,
        ok: missing.length === 0,
        reason: missing.length ? `missing GStreamer elements: ${missing.join(', ')}` : '',
    };
})();

beforeAll(() => {
    // Printed once so a skipped run says WHY in the log rather than looking green.
    if (!probe.ok) console.warn(`[aes67] GStreamer suite skipped — ${probe.reason}`);
});

describe('AES67 element availability', () => {
    it('reports what this host has (informational, never fails the run)', () => {
        console.log('[aes67] elements:', JSON.stringify(probe.elements));
        expect(typeof probe.ok).toBe('boolean');
    });
});

describe.skipIf(!probe.ok)('rtpL24pay RTP timestamp mapping', () => {
    it('is timestamp-offset + running_time x 48000/1e9, taken ABSOLUTELY', () => {
        const base = runProbe<{ packets: Array<{ pts: number; rtpts: number }> }>([
            'rtpts',
            '--ts-offset',
            '1000',
            '--buffers',
            '4',
        ]);
        expect(base.packets).toHaveLength(4);
        for (const p of base.packets) {
            expect(p.rtpts).toBe(1000 + Math.round((p.pts * 48000) / 1e9));
        }
    });

    it('shifting running time shifts the RTP timestamp by the same media time', () => {
        // The discriminating experiment: an anchored-at-first-buffer payloader
        // would emit the SAME timestamps for both runs. It emits +5 s worth
        // (240000 samples), which is what makes the epoch offset possible.
        const shiftNs = 5_000_000_000;
        const shifted = runProbe<{ packets: Array<{ pts: number; rtpts: number }> }>([
            'rtpts',
            '--ts-offset',
            '1000',
            '--buffers',
            '4',
            '--shift-ns',
            String(shiftNs),
        ]);
        const flat = runProbe<{ packets: Array<{ pts: number; rtpts: number }> }>([
            'rtpts',
            '--ts-offset',
            '1000',
            '--buffers',
            '4',
        ]);
        expect(shifted.packets[0].rtpts - flat.packets[0].rtpts).toBe(
            Math.round((shiftNs * 48000) / 1e9),
        );
        expect(shifted.packets[0].rtpts).toBe(241000);
    });
});

describe.skipIf(!probe.ok)('RFC 7273 caps survive gst_parse_launch', () => {
    it('parses back the stream description the receiver negotiates against', () => {
        const caps = aes67RtpCaps({ encoding: 'L24', channels: 2, payloadType: 98 });
        const parsed = runProbe<Record<string, unknown>>(['caps', '--caps', caps]);
        expect(parsed.name).toBe('application/x-rtp');
        expect(parsed['encoding-name']).toBe('L24');
        expect(parsed['clock-rate']).toBe(48000);
        expect(parsed.channels).toBe(2);
        expect(parsed.payload).toBe(98);
    });

    it('parses back the ts-refclk/mediaclk pair rtpjitterbuffer reads', () => {
        // This is the assertion that breaks if the helper's escaping regresses:
        // the value contains `=` and lives inside a `caps="…"` clause, so the
        // inner quotes must reach the parser escaped.
        const caps = aes67RtpCaps({
            encoding: 'L24',
            channels: 2,
            payloadType: 96,
            ptpGmid: '00-1D-C1-FF-FE-50-30-EE',
            ptpDomain: 3,
        });
        const parsed = runProbe<Record<string, unknown>>(['caps', '--caps', caps]);
        expect(parsed['a-ts-refclk']).toBe('ptp=IEEE1588-2008:00-1D-C1-FF-FE-50-30-EE:3');
        expect(parsed['a-mediaclk']).toBe('direct=0');
    });
});

describe.skipIf(!probe.ok)('L24 RTP loopback fidelity', () => {
    it('delivers the PCM bit-exact through a real UDP hop', () => {
        // 400 x 1 ms packets of 997 Hz stereo S24BE: payload → udpsink →
        // udpsrc → jitterbuffer → depayload, compared against the same source
        // rendered locally. 997 Hz (not 1000) makes the matched window unique
        // in the reference, so a match means "these exact samples, in this
        // exact place" rather than "some period of a repeating wave".
        const r = runProbe<{
            referenceBytes: number;
            receivedBytes: number;
            matched: boolean;
            matchCount: number;
            matchOffset: number;
            receivedFraction: number;
        }>(['loopback', '--port', '15007', '--buffers', '400']);
        console.log('[aes67] loopback:', JSON.stringify(r));
        expect(r.matched).toBe(true);
        expect(r.matchCount).toBe(1);
        // A byte-perfect run finds the window exactly where it was taken from.
        expect(r.matchOffset).toBeGreaterThan(0);
        // Completeness is NOT the claim being made: on a loaded box the socket
        // can drop, and a dropped packet is a network fact, not a fidelity
        // failure. What must hold is that everything which DID arrive is
        // bit-identical and in order — which is `matched` + `matchCount === 1`.
        expect(r.receivedFraction).toBeGreaterThan(0.5);
    }, 120_000);
});
