import { describe, it, expect } from 'vitest';
import { pulsePinnedStreamProps, PULSE_PINNED_STREAM_PROPS } from './pulseStreamProps.js';

describe('pulsePinnedStreamProps (#736)', () => {
    it('emits the WirePlumber pins as a single stream-properties clause', () => {
        expect(pulsePinnedStreamProps()).toBe(
            'stream-properties="props,node.dont-fallback=(string)true,node.linger=(string)true"',
        );
    });

    it('both pins are present — dont-fallback alone would make WirePlumber destroy a targetless stream', () => {
        expect(PULSE_PINNED_STREAM_PROPS['node.dont-fallback']).toBe('true');
        expect(PULSE_PINNED_STREAM_PROPS['node.linger']).toBe('true');
    });

    it('merges extra node properties after the pins, as (string) fields', () => {
        expect(pulsePinnedStreamProps({ 'node.latency': '2880/48000' })).toBe(
            'stream-properties="props,node.dont-fallback=(string)true,node.linger=(string)true,node.latency=(string)2880/48000"',
        );
    });

    it('an extra entry cannot silently drop a pin', () => {
        expect(pulsePinnedStreamProps({ 'node.linger': 'true' })).toBe(pulsePinnedStreamProps());
    });
});
