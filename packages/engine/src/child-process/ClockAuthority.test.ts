import { describe, it, expect } from 'vitest';
import { parseClockReady } from './ClockAuthority.js';

describe('parseClockReady', () => {
    it('extracts the port from a clock_ready event line', () => {
        expect(
            parseClockReady('GST_JSON:{"event":"clock_ready","port":46008}'),
        ).toBe(46008);
    });
    it('tolerates leading log noise before the GST_JSON prefix', () => {
        expect(parseClockReady('[gst] GST_JSON:{"event":"clock_ready","port":3010}')).toBe(3010);
    });
    it('returns null for non-clock lines, other events, and bad ports', () => {
        expect(parseClockReady('some stderr noise')).toBeNull();
        expect(parseClockReady('GST_JSON:{"event":"started"}')).toBeNull();
        expect(parseClockReady('GST_JSON:{"event":"clock_ready","port":0}')).toBeNull();
        expect(parseClockReady('GST_JSON:not json')).toBeNull();
    });
});
