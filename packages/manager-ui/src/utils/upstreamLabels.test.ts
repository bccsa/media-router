import { describe, expect, it } from 'vitest';
import { upstreamPorts } from './upstreamLabels';
import type { ConnectionState, ModuleState, PortInfo } from '@/stores/engines';

function mod(instanceId: string, ports: Array<Partial<PortInfo> & { id: string }>): ModuleState {
    return {
        instanceId,
        pluginId: 'p',
        displayName: instanceId,
        ports: ports.map((p) => ({
            direction: 'output',
            streamType: 'muxed/mpegts',
            label: p.id,
            ...p,
        })),
    } as ModuleState;
}

function conn(
    sourceModuleId: string,
    sourcePortId: string,
    sinkModuleId: string,
    sinkPortId: string,
): ConnectionState {
    return { id: `${sourcePortId}->${sinkPortId}`, sourceModuleId, sourcePortId, sinkModuleId, sinkPortId };
}

const splitter = mod('split', [
    {
        id: 'pid-0xc9',
        label: 'Audio nor (aac, PID 0xc9)',
        streamInfo: { language: 'nor', pid: 201, codec: 'aac', media: 'audio' },
    },
    {
        id: 'pid-0xca',
        label: 'Audio deu (aac, PID 0xca)',
        streamInfo: { language: 'deu', pid: 202, codec: 'aac', media: 'audio' },
    },
]);
const transcoder = mod('xcode', [{ id: 'mpegts-in', label: 'In', direction: 'input' }]);

describe('upstreamPorts', () => {
    it('maps a connected input pin to the upstream output port (with streamInfo)', () => {
        const map = upstreamPorts(
            { split: splitter, xcode: transcoder },
            [conn('split', 'pid-0xc9', 'xcode', 'mpegts-in')],
            'xcode',
        );
        expect(map.get('mpegts-in')).toHaveLength(1);
        expect(map.get('mpegts-in')![0].streamInfo).toMatchObject({ language: 'nor', pid: 201 });
    });

    it('returns every feed into a shared pin, in connection order (mixer inputs)', () => {
        const map = upstreamPorts(
            { split: splitter, xcode: transcoder },
            [
                conn('split', 'pid-0xc9', 'xcode', 'mpegts-in'),
                conn('split', 'pid-0xca', 'xcode', 'mpegts-in'),
            ],
            'xcode',
        );
        expect(map.get('mpegts-in')!.map((p) => p.streamInfo?.language)).toEqual(['nor', 'deu']);
    });

    it('ignores connections of other modules and unknown source ports', () => {
        const map = upstreamPorts(
            { split: splitter, xcode: transcoder },
            [
                conn('split', 'pid-0xc9', 'other', 'mpegts-in'),
                conn('split', 'gone-port', 'xcode', 'mpegts-in'),
            ],
            'xcode',
        );
        expect(map.size).toBe(0);
    });

    it('returns empty for a module with no inbound connections', () => {
        expect(upstreamPorts({ split: splitter, xcode: transcoder }, [], 'xcode').size).toBe(0);
    });
});
