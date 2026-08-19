import { describe, it, expect } from 'vitest';
import {
    aes67DepayloaderElement,
    aes67PayloaderElement,
    aes67PayloadBytes,
    aes67PtimeClauses,
    aes67RawCaps,
    aes67RawFormat,
    aes67RtpCaps,
    aes67SamplesPerPacket,
    clampChannels,
    clampPayloadType,
    clampPtime,
    AES67_DEFAULT_DSCP,
    AES67_SAMPLE_RATE,
    AES67_SAP_GROUP,
    AES67_SAP_PORT,
} from './aes67Helpers.js';

/**
 * The AES67 numbers that make a stream interoperable rather than merely
 * plausible: the 48 kHz/L24 caps a foreign receiver negotiates against, the
 * pinned packet time, and the RFC 7273 clock fields — which are only ever
 * emitted when a real grandmaster was named.
 */

describe('AES67 constants', () => {
    it('pins the SAP group, rate and DSCP the standard specifies', () => {
        expect(AES67_SAP_GROUP).toBe('239.255.255.255');
        expect(AES67_SAP_PORT).toBe(9875);
        expect(AES67_SAMPLE_RATE).toBe(48000);
        expect(AES67_DEFAULT_DSCP).toBe(46); // EF
    });
});

describe('encoding ↔ element mapping', () => {
    it('L24 is 24-bit big-endian, L16 is 16-bit big-endian', () => {
        expect(aes67RawFormat('L24')).toBe('S24BE');
        expect(aes67RawFormat('L16')).toBe('S16BE');
    });

    it('picks the matching payloader/depayloader pair', () => {
        expect(aes67PayloaderElement('L24')).toBe('rtpL24pay');
        expect(aes67DepayloaderElement('L24')).toBe('rtpL24depay');
        expect(aes67PayloaderElement('L16')).toBe('rtpL16pay');
        expect(aes67DepayloaderElement('L16')).toBe('rtpL16depay');
    });

    it('builds raw caps the payloader can accept as-is', () => {
        expect(aes67RawCaps('L24', 2)).toBe(
            'audio/x-raw,format=S24BE,rate=48000,channels=2,layout=interleaved',
        );
        expect(aes67RawCaps('L16', 8)).toContain('format=S16BE,rate=48000,channels=8');
    });
});

describe('aes67RtpCaps', () => {
    it('describes the stream fully — RTP itself carries no format', () => {
        const caps = aes67RtpCaps({ encoding: 'L24', channels: 2, payloadType: 96 });
        expect(caps).toBe(
            'application/x-rtp, media=(string)audio, clock-rate=(int)48000, ' +
                'encoding-name=(string)L24, channels=(int)2, payload=(int)96',
        );
    });

    it('omits the RFC 7273 fields when no grandmaster is named', () => {
        // Signalling a clock we are not locked to makes an rfc7273-sync receiver
        // schedule off the wrong reference — worse than not signalling at all.
        const caps = aes67RtpCaps({ encoding: 'L24', channels: 2, payloadType: 96 });
        expect(caps).not.toContain('ts-refclk');
        expect(caps).not.toContain('mediaclk');
    });

    it('emits the a- prefixed SDP attributes rtpjitterbuffer reads', () => {
        const caps = aes67RtpCaps({
            encoding: 'L24',
            channels: 2,
            payloadType: 98,
            ptpGmid: '00-1D-C1-FF-FE-50-30-EE',
            ptpDomain: 3,
        });
        // Escaped quotes: the value contains `=`, so it must be quoted inside
        // the structure, and the structure is nested in a `caps="…"` launch
        // clause. The unescaped form fails gst_parse_launch (pinned end-to-end
        // by plugins/aes67-core/tests/aes67Gst.test.ts, which parses it).
        expect(caps).toContain(
            'a-ts-refclk=(string)\\"ptp=IEEE1588-2008:00-1D-C1-FF-FE-50-30-EE:3\\"',
        );
        expect(caps).toContain('a-mediaclk=(string)\\"direct=0\\"');
        expect(caps).toContain('payload=(int)98');
    });

    it('defaults the PTP domain to 0', () => {
        const caps = aes67RtpCaps({ encoding: 'L16', channels: 1, payloadType: 96, ptpGmid: 'AA' });
        expect(caps).toContain('ptp=IEEE1588-2008:AA:0');
    });
});

describe('packet time', () => {
    it('pins min-ptime == max-ptime so the payloader cannot coalesce', () => {
        expect(aes67PtimeClauses(1)).toBe('min-ptime=1000000 max-ptime=1000000');
        expect(aes67PtimeClauses(0.125)).toBe('min-ptime=125000 max-ptime=125000');
    });

    it('counts samples and payload bytes per packet', () => {
        expect(aes67SamplesPerPacket(1)).toBe(48);
        expect(aes67SamplesPerPacket(0.125)).toBe(6);
        // The canonical AES67 packet: 48 samples x 2 ch x 3 bytes = 288 B.
        expect(aes67PayloadBytes('L24', 2, 1)).toBe(288);
        expect(aes67PayloadBytes('L16', 2, 1)).toBe(192);
        expect(aes67PayloadBytes('L24', 8, 4)).toBe(4608); // over any sane MTU
    });

    it('clamps to the AES67 range rather than emitting an uninteroperable value', () => {
        expect(clampPtime(4)).toBe(4);
        expect(clampPtime(10)).toBe(4);
        expect(clampPtime(0.01)).toBe(0.125);
        expect(clampPtime(0)).toBe(1);
        expect(clampPtime(Number.NaN)).toBe(1);
    });
});

describe('bounds on operator input', () => {
    it('clamps channels to 1-8', () => {
        expect(clampChannels(2)).toBe(2);
        expect(clampChannels(0)).toBe(1);
        expect(clampChannels(64)).toBe(8);
        expect(clampChannels(Number.NaN)).toBe(1);
        expect(clampChannels(2.7)).toBe(2);
    });

    it('clamps the payload type to the dynamic range 96-127', () => {
        expect(clampPayloadType(96)).toBe(96);
        expect(clampPayloadType(10)).toBe(96); // static PTs are 44.1 kHz — never AES67
        expect(clampPayloadType(200)).toBe(127);
        expect(clampPayloadType(Number.NaN)).toBe(96);
    });
});
