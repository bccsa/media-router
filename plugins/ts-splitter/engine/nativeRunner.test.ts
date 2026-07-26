import { describe, it, expect, vi } from 'vitest';
import { BUS_TS_CAPS, buildSpawnArgs, dispatchRunnerEvent } from './nativeRunner.js';

describe('buildSpawnArgs', () => {
    it('builds the full argv contract (input, caps, ts-id, outs with tees)', () => {
        expect(
            buildSpawnArgs({
                inputSocketPath: '/tmp/mr-bus-40000-abc.sock',
                tsId: 7,
                outputs: [
                    { pid: 0x65, port: 41000, streamType: 0x1b },
                    { pid: 0x1f0, port: 41001 },
                ],
            }),
        ).toEqual([
            '--input', '/tmp/mr-bus-40000-abc.sock',
            '--caps', BUS_TS_CAPS,
            '--ts-id', '7',
            '--out', '0x65:busout_41000:0x1b',
            '--out', '0x1f0:busout_41001',
        ]);
    });
});

describe('dispatchRunnerEvent', () => {
    function handlers() {
        return {
            onPluginEvent: vi.fn(),
            onInputStalled: vi.fn(),
            onInputResumed: vi.fn(),
            onStats: vi.fn(),
        };
    }

    it('routes plugin_event with channel + payload', () => {
        const h = handlers();
        dispatchRunnerEvent(
            { event: 'plugin_event', channel: 'tssplit:discovered', payload: { pcrPid: 0x65 } },
            h,
        );
        expect(h.onPluginEvent).toHaveBeenCalledWith('tssplit:discovered', { pcrPid: 0x65 });
    });

    it('routes stall transitions and stats; ignores the rest', () => {
        const h = handlers();
        dispatchRunnerEvent({ event: 'input_stalled', ms: 2100 }, h);
        expect(h.onInputStalled).toHaveBeenCalledWith(2100);
        dispatchRunnerEvent({ event: 'input_resumed' }, h);
        expect(h.onInputResumed).toHaveBeenCalledTimes(1);
        dispatchRunnerEvent({ stats: { clients: 3, in_kbps: 8700 } }, h);
        expect(h.onStats).toHaveBeenCalledWith({ clients: 3, in_kbps: 8700 });
        dispatchRunnerEvent({ event: 'attached', socket: '/x' }, h);
        expect(h.onPluginEvent).not.toHaveBeenCalled();
    });
});
