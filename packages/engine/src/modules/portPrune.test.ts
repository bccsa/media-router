import { describe, expect, it, vi } from 'vitest';
import { connectionsOnPorts, retireConnectionsOnPorts } from './portPrune.js';

const edge = (id: string, src: string, srcPort: string, sink: string, sinkPort: string) => ({
    id,
    sourceModuleId: src,
    sourcePortId: srcPort,
    sinkModuleId: sink,
    sinkPortId: sinkPort,
});
const conns = () => [
    edge('a', 'split', 'pid-0x100', 'mux', 'input-0'),
    edge('b', 'split', 'pid-0x140', 'mux', 'input-1'),
    edge('c', 'mux', 'mpegts-out', 'srt', 'mpegts-in'),
    edge('d', 'other', 'input-1', 'x', 'in'), // same port id on another module
];

describe('connectionsOnPorts', () => {
    it('picks the edges whose sink OR source is one of the vanished ports of THAT module', () => {
        expect(connectionsOnPorts(conns(), 'mux', ['input-1']).map((c) => c.id)).toEqual(['b']);
        expect(connectionsOnPorts(conns(), 'mux', ['mpegts-out']).map((c) => c.id)).toEqual(['c']);
        expect(
            connectionsOnPorts(conns(), 'mux', ['input-0', 'input-1']).map((c) => c.id),
        ).toEqual(['a', 'b']);
    });
    it('leaves everything alone for ports that still exist or other modules', () => {
        expect(connectionsOnPorts(conns(), 'mux', ['input-7'])).toEqual([]);
        expect(connectionsOnPorts(conns(), 'nobody', ['input-1'])).toEqual([]);
        expect(connectionsOnPorts(conns(), 'mux', [])).toEqual([]);
    });
});

describe('retireConnectionsOnPorts', () => {
    it('drops the edges from config, tears them down live, and publishes id-based removes', async () => {
        const config: Record<string, unknown> = { connections: conns() };
        const removeLiveConnection = vi.fn().mockResolvedValue(true);
        const publish = vi.fn();
        const ids = retireConnectionsOnPorts(
            { getConfig: () => config, removeLiveConnection, publish },
            'mux',
            ['input-1'],
        );
        expect(ids).toEqual(['b']);
        expect((config.connections as Array<{ id: string }>).map((c) => c.id)).toEqual(['a', 'c', 'd']);
        expect(removeLiveConnection).toHaveBeenCalledWith('b');
        expect(publish).toHaveBeenCalledWith([{ op: 'remove', path: '/connections/b' }]);
    });
    it('is silent when nothing is attached, and survives a not-live teardown', async () => {
        const config: Record<string, unknown> = { connections: conns() };
        const publish = vi.fn();
        expect(
            retireConnectionsOnPorts(
                { getConfig: () => config, removeLiveConnection: vi.fn(), publish },
                'mux',
                ['input-9'],
            ),
        ).toEqual([]);
        expect(publish).not.toHaveBeenCalled();
        const rejecting = vi.fn().mockRejectedValue(new Error('not live'));
        retireConnectionsOnPorts(
            { getConfig: () => config, removeLiveConnection: rejecting, publish },
            'mux',
            ['input-0'],
        );
        await new Promise((r) => setTimeout(r, 0)); // the rejection is swallowed, not thrown
        expect(publish).toHaveBeenCalledWith([{ op: 'remove', path: '/connections/a' }]);
    });
});
