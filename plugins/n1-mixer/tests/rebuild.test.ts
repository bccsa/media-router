import { describe, it, expect, vi } from 'vitest';
import { fakeOwnPipeWire } from '../../../packages/engine/src/audio/testing/fakeOwnPipeWire.js';
import { N1MixerModule } from '../engine/N1MixerModule.js';

/** v104 F3: a rebuild after a PipeWire restart that fails part-way, then one that succeeds. */
describe('N1MixerModule rebuild (v104 F3)', () => {
    it('a rebuild failing at a loopback, then one that succeeds: each sink and loopback once', async () => {
        const pw = fakeOwnPipeWire();
        const m = new N1MixerModule() as any;
        m.services = { instanceId: 'n1', pipeWire: pw, mediaRouter: {} };
        m.config = { pairCount: 3 };
        m.pairCount = 3;
        pw.state.failLoadAt = 6 + 2; // 6 sinks, then the third loopback
        await expect(m.onDeviceReconnected()).rejects.toThrow('load failed');
        expect(Object.keys(pw.counts())).toHaveLength(8); // the attempt's leftovers
        await m.onDeviceReconnected();
        const counts = pw.counts();
        expect(Object.keys(counts)).toHaveLength(6 + 6);
        expect(Object.values(counts).every((n) => n === 1)).toBe(true);
    });

    it('starts its watchdog before its graph (review minor 4)', async () => {
        const pw = fakeOwnPipeWire();
        const m = new N1MixerModule() as any;
        const order: string[] = [];
        m.services = { instanceId: 'n1', pipeWire: pw, mediaRouter: {} };
        m.config = { pairCount: 2 };
        m.startDeviceWatchdog = () => order.push('watchdog');
        const graph = m.bringUpGraph.bind(m);
        m.bringUpGraph = async () => {
            order.push('graph');
            return graph();
        };
        vi.spyOn(m.timing, 'watchPipeWire').mockImplementation(() => {});
        await m.onStart();
        expect(order).toEqual(['watchdog', 'graph']);
    });
});
