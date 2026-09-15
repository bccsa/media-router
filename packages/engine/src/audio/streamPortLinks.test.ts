import { describe, it, expect, vi } from 'vitest';
import {
    linkStreamPorts,
    portsFromDump,
    StreamPortLinker,
    type StreamLinkDeps,
} from './streamPortLinks.js';

const DEV_IN = 'alsa_input.usb-KT';
const DEV_OUT = 'alsa_output.usb-KT';

function node(id: number, name: string) {
    return { id, type: 'PipeWire:Interface:Node', info: { props: { 'node.name': name } } };
}
function port(
    id: number,
    nodeId: number,
    index: number,
    direction: 'input' | 'output',
    name: string,
) {
    return {
        id,
        type: 'PipeWire:Interface:Port',
        info: { direction, props: { 'node.id': nodeId, 'port.id': index, 'port.name': name } },
    };
}
/** A 48-ch capture card (object ids in channel order) and a stream whose port
 *  object ids are deliberately NOT in channel order — like the field. */
function graph(
    streamPorts: Array<[id: number, index: number, name: string]>,
    streamNode = 'MR_PW_ain-1',
) {
    const d: unknown[] = [node(55, DEV_IN), node(54, DEV_OUT), node(400, streamNode)];
    for (let i = 0; i < 48; i++) d.push(port(100 + i, 55, i, 'output', `capture_AUX${i}`));
    for (let i = 0; i < 48; i++) d.push(port(200 + i, 54, i, 'input', `playback_AUX${i}`));
    for (const [id, index, name] of streamPorts) d.push(port(id, 400, index, 'input', name));
    return d;
}
function deps(
    dump: unknown[] | (() => unknown[]),
): StreamLinkDeps & { link: ReturnType<typeof vi.fn> } {
    return {
        dump: vi.fn(async () => (typeof dump === 'function' ? dump() : dump)),
        link: vi.fn(async () => undefined),
    };
}

describe('portsFromDump', () => {
    it('orders by port.id (channel index), not by object id', () => {
        const d = graph([
            [901, 1, 'input_2'],
            [305, 0, 'input_1'],
        ]);
        expect(portsFromDump(d, 'MR_PW_ain-1', 'input').map((p) => p.name)).toEqual([
            'input_1',
            'input_2',
        ]);
        expect(portsFromDump(d, DEV_IN, 'output')[8]).toMatchObject({
            index: 8,
            id: 108,
            name: 'capture_AUX8',
        });
    });

    it('picks the newest node when a restart briefly leaves two with the same name', () => {
        const d = graph([[305, 0, 'input_1']]);
        d.push(node(500, 'MR_PW_ain-1'), port(600, 500, 0, 'input', 'input_1'));
        expect(portsFromDump(d, 'MR_PW_ain-1', 'input').map((p) => p.id)).toEqual([600]);
    });

    it('returns nothing for an unknown node or the wrong direction', () => {
        const d = graph([[305, 0, 'input_1']]);
        expect(portsFromDump(d, 'nope', 'input')).toEqual([]);
        expect(portsFromDump(d, 'MR_PW_ain-1', 'output')).toEqual([]);
    });
});

describe('linkStreamPorts', () => {
    it('links stream channel k to device channel firstIndex + k, by object id (capture)', async () => {
        const dp = deps(
            graph([
                [901, 1, 'input_2'],
                [305, 0, 'input_1'],
            ]),
        );
        const r = await linkStreamPorts(
            {
                streamNode: 'MR_PW_ain-1',
                direction: 'capture',
                deviceNode: DEV_IN,
                firstIndex: 8,
                channels: 2,
            },
            { deps: dp },
        );
        expect(r).toEqual({ linked: 2, missing: 0, streamPorts: 2, devicePorts: 48 });
        // device → stream, AUX8 (id 108) → input_1 (id 305), AUX9 → input_2
        expect(dp.link.mock.calls).toEqual([
            [108, 305],
            [109, 901],
        ]);
    });

    it('playback links stream output ports into the device input ports', async () => {
        const d = graph([]);
        d.push(port(700, 400, 0, 'output', 'output_1'));
        const dp = deps(d);
        const r = await linkStreamPorts(
            {
                streamNode: 'MR_PW_ain-1',
                direction: 'playback',
                deviceNode: DEV_OUT,
                firstIndex: 3,
                channels: 1,
            },
            { deps: dp },
        );
        expect(r.linked).toBe(1);
        expect(dp.link.mock.calls).toEqual([[700, 203]]);
    });

    it('dual-mono feeds the one device channel to every stream channel', async () => {
        const dp = deps(
            graph([
                [305, 0, 'input_1'],
                [306, 1, 'input_2'],
            ]),
        );
        await linkStreamPorts(
            {
                streamNode: 'MR_PW_ain-1',
                direction: 'capture',
                deviceNode: DEV_IN,
                firstIndex: 47,
                channels: 2,
                dualMono: true,
            },
            { deps: dp },
        );
        expect(dp.link.mock.calls).toEqual([
            [147, 305],
            [147, 306],
        ]);
    });

    it('a range running past the device links what exists and reports the rest missing', async () => {
        const dp = deps(
            graph(
                Array.from(
                    { length: 8 },
                    (_, i) => [300 + i, i, `input_${i + 1}`] as [number, number, string],
                ),
            ),
        );
        const r = await linkStreamPorts(
            {
                streamNode: 'MR_PW_ain-1',
                direction: 'capture',
                deviceNode: DEV_IN,
                firstIndex: 44,
                channels: 8,
            },
            { deps: dp },
        );
        expect(r).toMatchObject({ linked: 4, missing: 4 });
    });

    it('waits for the stream ports to appear, then links', async () => {
        let calls = 0;
        const dp = deps(() =>
            ++calls < 3
                ? graph([])
                : graph([
                      [305, 0, 'input_1'],
                      [306, 1, 'input_2'],
                  ]),
        );
        const r = await linkStreamPorts(
            {
                streamNode: 'MR_PW_ain-1',
                direction: 'capture',
                deviceNode: DEV_IN,
                firstIndex: 0,
                channels: 2,
            },
            { deps: dp, intervalMs: 1 },
        );
        expect(r.linked).toBe(2);
        expect(calls).toBe(3);
    });

    it('gives up after the timeout with streamPorts=0 and no links', async () => {
        const dp = deps(graph([]));
        const r = await linkStreamPorts(
            {
                streamNode: 'MR_PW_ain-1',
                direction: 'capture',
                deviceNode: DEV_IN,
                firstIndex: 0,
                channels: 2,
            },
            { deps: dp, timeoutMs: 5, intervalMs: 1 },
        );
        expect(r).toEqual({ linked: 0, missing: 0, streamPorts: 0, devicePorts: 48 });
        expect(dp.link).not.toHaveBeenCalled();
    });
});

describe('StreamPortLinker', () => {
    it('runs the plan, reports the result, and collapses overlapping calls', async () => {
        const dp = deps(
            graph([
                [305, 0, 'input_1'],
                [306, 1, 'input_2'],
            ]),
        );
        const onResult = vi.fn();
        const plan = {
            streamNode: 'MR_PW_ain-1',
            direction: 'capture' as const,
            deviceNode: DEV_IN,
            firstIndex: 0,
            channels: 2,
        };
        const linker = new StreamPortLinker({
            getPlan: () => plan,
            onResult,
            onError: vi.fn(),
            deps: () => dp,
        });
        await Promise.all([linker.ensure(), linker.ensure()]);
        expect(dp.dump).toHaveBeenCalledTimes(1);
        expect(onResult).toHaveBeenCalledTimes(1);
        expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ linked: 2 }), plan);
        // A later call (the PLAYING after a runner restart) links again.
        await linker.ensure();
        expect(onResult).toHaveBeenCalledTimes(2);
    });

    it('is a no-op without a plan and routes failures to onError', async () => {
        const onResult = vi.fn();
        const onError = vi.fn();
        const none = new StreamPortLinker({ getPlan: () => null, onResult, onError });
        await none.ensure();
        expect(onResult).not.toHaveBeenCalled();
        const failing = new StreamPortLinker({
            getPlan: () => ({
                streamNode: 'x',
                direction: 'capture',
                deviceNode: DEV_IN,
                firstIndex: 0,
                channels: 2,
            }),
            onResult,
            onError,
            deps: () => ({
                dump: async () => {
                    throw new Error('pw-dump exploded');
                },
                link: async () => undefined,
            }),
        });
        await failing.ensure();
        expect(onError).toHaveBeenCalledWith(
            expect.objectContaining({ message: 'pw-dump exploded' }),
        );
    });
});
