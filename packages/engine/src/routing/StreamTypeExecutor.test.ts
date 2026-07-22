import { describe, it, expect } from 'vitest';
import { StreamTypeExecutorRegistry, type StreamTypeExecutor } from './StreamTypeExecutor.js';
import type { ActiveHandle } from './MediaRouter.js';

function makeExecutor(streamType: string, handleType: ActiveHandle['type']): StreamTypeExecutor {
    return {
        streamType,
        handleType,
        execute: async () => null,
        teardown: async () => undefined,
    };
}

describe('StreamTypeExecutorRegistry', () => {
    it('dispatches execute by streamType and teardown by handleType', () => {
        const reg = new StreamTypeExecutorRegistry();
        const udp = makeExecutor('muxed/mpegts', 'udp');
        reg.register(udp);
        expect(reg.forStreamType('muxed/mpegts')).toBe(udp);
        expect(reg.forHandle({ connectionId: 'c', type: 'udp' })).toBe(udp);
    });

    it('aliases extra stream types onto the SAME instance (audio/302m rides the TS executor)', () => {
        const reg = new StreamTypeExecutorRegistry();
        const udp = makeExecutor('muxed/mpegts', 'udp');
        reg.register(udp, ['audio/302m']);
        // One instance serves both types — execute state (e.g. materialize
        // tracking) and teardown dispatch stay coherent.
        expect(reg.forStreamType('audio/302m')).toBe(udp);
        expect(reg.forStreamType('muxed/mpegts')).toBe(udp);
        expect(reg.forHandle({ connectionId: 'c', type: 'udp' })).toBe(udp);
        expect(reg.streamTypes().sort()).toEqual(['audio/302m', 'muxed/mpegts']);
    });
});
