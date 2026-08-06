import { describe, it, expect } from 'vitest';
import { CodecMemory, codecMemoryKey } from './codecMemory.js';

describe('codecMemoryKey', () => {
    const source = { sourceModuleId: 'ts-input-1', sourcePortId: 'mpegts-out' };

    it('is stable for the same consumer/producer edge', () => {
        expect(codecMemoryKey('player-1', source)).toBe(codecMemoryKey('player-1', { ...source }));
    });

    it('separates a different producer, a different port and a different consumer', () => {
        const key = codecMemoryKey('player-1', source);
        expect(codecMemoryKey('player-1', { ...source, sourceModuleId: 'ts-input-2' })).not.toBe(
            key,
        );
        expect(codecMemoryKey('player-1', { ...source, sourcePortId: 'pid-0x65' })).not.toBe(key);
        expect(codecMemoryKey('player-2', source)).not.toBe(key);
    });

    it('has no key for an unidentifiable source — never a shared one', () => {
        // Sharing a placeholder key across sources would hand one feed's codec
        // to another; no key means "bootstrap", which is always safe.
        expect(codecMemoryKey('player-1', undefined)).toBeUndefined();
        expect(codecMemoryKey('player-1', {})).toBeUndefined();
        expect(codecMemoryKey('', source)).toBeUndefined();
    });
});

describe('CodecMemory', () => {
    const key = codecMemoryKey('player-1', {
        sourceModuleId: 'ts-input-1',
        sourcePortId: 'mpegts-out',
    });

    it('recalls what was last remembered for an edge', () => {
        const memory = new CodecMemory();
        expect(memory.recall(key)).toBeUndefined();
        memory.remember(key, 'h265');
        expect(memory.recall(key)).toBe('h265');
        // A codec change on the same edge overwrites — the memory is "last
        // seen", not "first seen".
        memory.remember(key, 'h264');
        expect(memory.recall(key)).toBe('h264');
    });

    it('ignores an absent key on both sides', () => {
        const memory = new CodecMemory();
        memory.remember(undefined, 'h265');
        expect(memory.recall(undefined)).toBeUndefined();
        expect(memory.recall(key)).toBeUndefined();
    });

    it('clears', () => {
        const memory = new CodecMemory();
        memory.remember(key, 'h265');
        memory.clear();
        expect(memory.recall(key)).toBeUndefined();
    });

    it('forgets ONE edge, leaving the rest of the map intact', () => {
        // The stall path forgets the edge that went silent (its feed may have
        // been reconfigured); every other player/edge pair keeps its fast start.
        const other = codecMemoryKey('player-2', {
            sourceModuleId: 'ts-input-1',
            sourcePortId: 'mpegts-out',
        });
        const memory = new CodecMemory();
        memory.remember(key, 'h265');
        memory.remember(other, 'h265');
        memory.forget(key);
        expect(memory.recall(key)).toBeUndefined();
        expect(memory.recall(other)).toBe('h265');
    });

    it('forgetting an absent or unknown key is a no-op', () => {
        const memory = new CodecMemory();
        memory.remember(key, 'h265');
        memory.forget(undefined);
        memory.forget('never-seen');
        expect(memory.recall(key)).toBe('h265');
    });
});
