import { describe, it, expect } from 'vitest';
import { wire302mChannels } from './channelWidth';

describe('wire302mChannels', () => {
    it('snaps a configured mix width onto the 302M wire set', () => {
        expect(wire302mChannels(1)).toBe(2); // mono → dual-mono stereo
        expect(wire302mChannels(2)).toBe(2);
        expect(wire302mChannels(3)).toBe(4);
        expect(wire302mChannels(6)).toBe(6);
        expect(wire302mChannels(8)).toBe(8);
        expect(wire302mChannels(12)).toBe(8);
        expect(wire302mChannels(undefined)).toBe(2);
        expect(wire302mChannels('junk')).toBe(2);
    });
});
