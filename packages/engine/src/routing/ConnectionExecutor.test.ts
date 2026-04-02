import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConnectionExecutor } from './ConnectionExecutor.js';
import type { Connection, ActiveHandle } from './MediaRouter.js';
import type { PipeWireManager } from '../audio/PipeWireManager.js';
import type { ModuleInstance } from '../modules/ModuleInstance.js';

function makeConnection(overrides: Partial<Connection> = {}): Connection {
    return {
        id: 'src:out-sink:in',
        sourceModuleId: 'src-mod',
        sourcePortId: 'out',
        sinkModuleId: 'sink-mod',
        sinkPortId: 'in',
        streamType: 'audio/pcm',
        ...overrides,
    };
}

function makeMockModule(overrides: Partial<ModuleInstance> = {}): ModuleInstance {
    return {
        running: true,
        getPipeWireNodes: vi.fn(() => ({ source: 'src-node', sink: 'sink-node' })),
        getPipeWireNodeForPort: vi.fn(() => undefined),
        stop: vi.fn(async () => {}),
        start: vi.fn(async () => {}),
        ...overrides,
    } as unknown as ModuleInstance;
}

function makeMockPipeWire(): {
    [K in keyof PipeWireManager]: PipeWireManager[K] extends (...args: any[]) => any
        ? ReturnType<typeof vi.fn>
        : PipeWireManager[K];
} {
    return {
        loadLoopback: vi.fn(async () => 42),
        unloadModule: vi.fn(async () => {}),
        pwLink: vi.fn(() => 100),
        pwUnlink: vi.fn(),
        pwUnlinkByName: vi.fn(() => true),
        pwUnlinkAllBetween: vi.fn(),
        listPorts: vi.fn((node: string, dir: string) => {
            if (dir === 'output') return ['src-node:output_FL', 'src-node:output_FR'];
            return ['sink-node:input_FL', 'sink-node:input_FR'];
        }),
    } as any;
}

describe('ConnectionExecutor', () => {
    let pw: ReturnType<typeof makeMockPipeWire>;
    let modules: Map<string, ModuleInstance>;
    let udpPorts: Map<string, number>;
    let executor: ConnectionExecutor;

    beforeEach(() => {
        pw = makeMockPipeWire();
        modules = new Map();
        udpPorts = new Map();
        executor = new ConnectionExecutor(
            pw as unknown as PipeWireManager,
            (id) => modules.get(id),
            (id) => udpPorts.get(id),
            '239.0.0.1',
            (id) => id.toUpperCase(),
        );
    });

    // --- execute() dispatch ---

    describe('execute()', () => {
        it('returns null for unknown stream type', async () => {
            const conn = makeConnection({ streamType: 'video/raw' as any });
            const result = await executor.execute(conn);
            expect(result).toBeNull();
        });

        it('dispatches audio/pcm to loopback', async () => {
            const srcMod = makeMockModule({
                getPipeWireNodes: vi.fn(() => ({ source: 'mic-node' })),
            });
            const sinkMod = makeMockModule({
                getPipeWireNodes: vi.fn(() => ({ sink: 'encoder-node' })),
            });
            modules.set('src-mod', srcMod);
            modules.set('sink-mod', sinkMod);

            const conn = makeConnection();
            const result = await executor.execute(conn);

            expect(result).toEqual({
                connectionId: conn.id,
                type: 'loopback',
                paModuleId: 42,
            });
            expect(pw.loadLoopback).toHaveBeenCalledWith(
                conn.id, 'mic-node', 'encoder-node', 2, 48000, 'src-mod',
            );
        });

        it('dispatches muxed/mpegts to UDP', async () => {
            const sinkMod = makeMockModule();
            modules.set('sink-mod', sinkMod);
            udpPorts.set('src-mod', 5004);

            const conn = makeConnection({ streamType: 'muxed/mpegts' });
            const result = await executor.execute(conn);

            expect(result).toEqual({
                connectionId: conn.id,
                type: 'udp',
                udpPort: 5004,
            });
        });
    });

    // --- executeAudio ---

    describe('executeAudio (audio/pcm)', () => {
        it('returns null when source module is missing', async () => {
            modules.set('sink-mod', makeMockModule());
            const result = await executor.execute(makeConnection());
            expect(result).toBeNull();
        });

        it('returns null when sink module is missing', async () => {
            modules.set('src-mod', makeMockModule());
            const result = await executor.execute(makeConnection());
            expect(result).toBeNull();
        });

        it('returns null when source has no PipeWire source node', async () => {
            modules.set('src-mod', makeMockModule({
                getPipeWireNodes: vi.fn(() => ({ sink: 'only-sink' })),
            }));
            modules.set('sink-mod', makeMockModule({
                getPipeWireNodes: vi.fn(() => ({ sink: 'sink-node' })),
            }));
            const result = await executor.execute(makeConnection());
            expect(result).toBeNull();
        });

        it('returns null when sink has no PipeWire sink node', async () => {
            modules.set('src-mod', makeMockModule({
                getPipeWireNodes: vi.fn(() => ({ source: 'src-node' })),
            }));
            modules.set('sink-mod', makeMockModule({
                getPipeWireNodes: vi.fn(() => ({ source: 'only-source' })),
            }));
            const result = await executor.execute(makeConnection());
            expect(result).toBeNull();
        });

        it('uses port-specific lookup when available', async () => {
            const srcMod = makeMockModule({
                getPipeWireNodeForPort: vi.fn(() => ({ source: 'port-specific-src' })),
                getPipeWireNodes: vi.fn(() => ({ source: 'module-level-src' })),
            });
            const sinkMod = makeMockModule({
                getPipeWireNodeForPort: vi.fn(() => ({ sink: 'port-specific-sink' })),
                getPipeWireNodes: vi.fn(() => ({ sink: 'module-level-sink' })),
            });
            modules.set('src-mod', srcMod);
            modules.set('sink-mod', sinkMod);

            await executor.execute(makeConnection());

            expect(pw.loadLoopback).toHaveBeenCalledWith(
                expect.any(String), 'port-specific-src', 'port-specific-sink', 2, 48000, 'src-mod',
            );
        });

        it('falls back to module-level nodes when port-specific returns undefined', async () => {
            const srcMod = makeMockModule({
                getPipeWireNodeForPort: vi.fn(() => undefined),
                getPipeWireNodes: vi.fn(() => ({ source: 'module-src' })),
            });
            const sinkMod = makeMockModule({
                getPipeWireNodeForPort: vi.fn(() => undefined),
                getPipeWireNodes: vi.fn(() => ({ sink: 'module-sink' })),
            });
            modules.set('src-mod', srcMod);
            modules.set('sink-mod', sinkMod);

            await executor.execute(makeConnection());

            expect(pw.loadLoopback).toHaveBeenCalledWith(
                expect.any(String), 'module-src', 'module-sink', 2, 48000, 'src-mod',
            );
        });

        it('creates loopback for audio/pcm without channelMap', async () => {
            modules.set('src-mod', makeMockModule({
                getPipeWireNodes: vi.fn(() => ({ source: 'mic' })),
            }));
            modules.set('sink-mod', makeMockModule({
                getPipeWireNodes: vi.fn(() => ({ sink: 'enc' })),
            }));

            const result = await executor.execute(makeConnection());

            expect(result).toEqual({
                connectionId: 'src:out-sink:in',
                type: 'loopback',
                paModuleId: 42,
            });
        });
    });

    // --- executePwLink (channelMap) ---

    describe('executePwLink (audio/pcm with channelMap)', () => {
        function setupPwLinkModules() {
            modules.set('src-mod', makeMockModule({
                getPipeWireNodes: vi.fn(() => ({ source: 'src-node' })),
            }));
            modules.set('sink-mod', makeMockModule({
                getPipeWireNodes: vi.fn(() => ({ sink: 'sink-node' })),
            }));
        }

        it('creates pw-links for each channelMap entry', async () => {
            setupPwLinkModules();
            const conn = makeConnection({
                channelMap: [
                    { srcChannel: 0, dstChannel: 0 },
                    { srcChannel: 1, dstChannel: 1 },
                ],
            });

            const result = await executor.execute(conn);

            expect(pw.pwUnlinkAllBetween).toHaveBeenCalledWith('src-node', 'sink-node');
            expect(pw.listPorts).toHaveBeenCalledWith('src-node', 'output');
            expect(pw.listPorts).toHaveBeenCalledWith('sink-node', 'input');
            expect(pw.pwLink).toHaveBeenCalledTimes(2);
            expect(pw.pwLink).toHaveBeenCalledWith('src-node:output_FL', 'sink-node:input_FL');
            expect(pw.pwLink).toHaveBeenCalledWith('src-node:output_FR', 'sink-node:input_FR');

            expect(result).toEqual({
                connectionId: conn.id,
                type: 'pw-link',
                pwLinkIds: [100, 100],
                pwLinkPairs: [
                    { src: 'src-node:output_FL', dst: 'sink-node:input_FL' },
                    { src: 'src-node:output_FR', dst: 'sink-node:input_FR' },
                ],
            });
        });

        it('skips entries where source channel is out of range', async () => {
            setupPwLinkModules();
            const conn = makeConnection({
                channelMap: [{ srcChannel: 5, dstChannel: 0 }],
            });

            const result = await executor.execute(conn);

            expect(pw.pwLink).not.toHaveBeenCalled();
            expect(result!.pwLinkIds).toEqual([]);
            expect(result!.pwLinkPairs).toEqual([]);
        });

        it('skips entries where sink channel is out of range', async () => {
            setupPwLinkModules();
            const conn = makeConnection({
                channelMap: [{ srcChannel: 0, dstChannel: 5 }],
            });

            const result = await executor.execute(conn);

            expect(pw.pwLink).not.toHaveBeenCalled();
            expect(result!.pwLinkIds).toEqual([]);
        });

        it('handles pwLink failure gracefully and continues', async () => {
            setupPwLinkModules();
            pw.pwLink.mockImplementationOnce(() => { throw new Error('link failed'); });
            pw.pwLink.mockReturnValueOnce(200);

            const conn = makeConnection({
                channelMap: [
                    { srcChannel: 0, dstChannel: 0 },
                    { srcChannel: 1, dstChannel: 1 },
                ],
            });

            const result = await executor.execute(conn);

            // First link fails, second succeeds
            expect(result!.pwLinkIds).toEqual([200]);
            expect(result!.pwLinkPairs).toEqual([
                { src: 'src-node:output_FR', dst: 'sink-node:input_FR' },
            ]);
        });
    });

    // --- executeUdp ---

    describe('executeUdp (muxed/mpegts)', () => {
        it('returns null when decoder module is missing', async () => {
            udpPorts.set('src-mod', 5004);
            const result = await executor.execute(makeConnection({ streamType: 'muxed/mpegts' }));
            expect(result).toBeNull();
        });

        it('returns null when encoder has no assigned port', async () => {
            modules.set('sink-mod', makeMockModule());
            const result = await executor.execute(makeConnection({ streamType: 'muxed/mpegts' }));
            expect(result).toBeNull();
        });

        it('stops and restarts a running decoder', async () => {
            const sinkMod = makeMockModule({ running: true });
            modules.set('sink-mod', sinkMod);
            udpPorts.set('src-mod', 5004);

            await executor.execute(makeConnection({ streamType: 'muxed/mpegts' }));

            expect(sinkMod.stop).toHaveBeenCalled();
            expect(sinkMod.start).toHaveBeenCalled();
        });

        it('starts a non-running decoder without stopping first', async () => {
            const sinkMod = makeMockModule({ running: false });
            modules.set('sink-mod', sinkMod);
            udpPorts.set('src-mod', 5004);

            await executor.execute(makeConnection({ streamType: 'muxed/mpegts' }));

            expect(sinkMod.stop).not.toHaveBeenCalled();
            expect(sinkMod.start).toHaveBeenCalled();
        });

        it('returns handle even when decoder start fails', async () => {
            const sinkMod = makeMockModule({
                start: vi.fn(async () => { throw new Error('start failed'); }),
            });
            modules.set('sink-mod', sinkMod);
            udpPorts.set('src-mod', 5004);

            const result = await executor.execute(makeConnection({ streamType: 'muxed/mpegts' }));

            expect(result).toEqual({
                connectionId: 'src:out-sink:in',
                type: 'udp',
                udpPort: 5004,
            });
        });
    });

    // --- teardown ---

    describe('teardown()', () => {
        it('unloads PA module for loopback handle', async () => {
            const handle: ActiveHandle = {
                connectionId: 'c1',
                type: 'loopback',
                paModuleId: 99,
            };

            await executor.teardown(handle, undefined);

            expect(pw.unloadModule).toHaveBeenCalledWith(99);
        });

        it('skips unload when loopback has no paModuleId', async () => {
            const handle: ActiveHandle = {
                connectionId: 'c1',
                type: 'loopback',
                paModuleId: undefined,
            };

            await executor.teardown(handle, undefined);

            expect(pw.unloadModule).not.toHaveBeenCalled();
        });

        it('removes pw-link by name, by ID, and sweeps', async () => {
            const handle: ActiveHandle = {
                connectionId: 'c1',
                type: 'pw-link',
                pwLinkIds: [10, 20],
                pwLinkPairs: [
                    { src: 'src-node:output_FL', dst: 'sink-node:input_FL' },
                    { src: 'src-node:output_FR', dst: 'sink-node:input_FR' },
                ],
            };

            await executor.teardown(handle, undefined);

            // Step 1: unlink by name
            expect(pw.pwUnlinkByName).toHaveBeenCalledWith('src-node:output_FL', 'sink-node:input_FL');
            expect(pw.pwUnlinkByName).toHaveBeenCalledWith('src-node:output_FR', 'sink-node:input_FR');

            // Step 2: unlink by ID
            expect(pw.pwUnlink).toHaveBeenCalledWith(10);
            expect(pw.pwUnlink).toHaveBeenCalledWith(20);

            // Step 3: sweep all between nodes
            expect(pw.pwUnlinkAllBetween).toHaveBeenCalledWith('src-node', 'sink-node');
        });

        it('skips link ID 0 during pw-link teardown', async () => {
            const handle: ActiveHandle = {
                connectionId: 'c1',
                type: 'pw-link',
                pwLinkIds: [0, 15],
                pwLinkPairs: [
                    { src: 'src-node:output_FL', dst: 'sink-node:input_FL' },
                ],
            };

            await executor.teardown(handle, undefined);

            expect(pw.pwUnlink).not.toHaveBeenCalledWith(0);
            expect(pw.pwUnlink).toHaveBeenCalledWith(15);
        });

        it('handles pw-link teardown with empty arrays', async () => {
            const handle: ActiveHandle = {
                connectionId: 'c1',
                type: 'pw-link',
                pwLinkIds: [],
                pwLinkPairs: [],
            };

            await executor.teardown(handle, undefined);

            expect(pw.pwUnlinkByName).not.toHaveBeenCalled();
            expect(pw.pwUnlink).not.toHaveBeenCalled();
            expect(pw.pwUnlinkAllBetween).not.toHaveBeenCalled();
        });

        it('handles pw-link teardown with no pwLinkPairs/pwLinkIds', async () => {
            const handle: ActiveHandle = {
                connectionId: 'c1',
                type: 'pw-link',
            };

            await executor.teardown(handle, undefined);

            expect(pw.pwUnlinkByName).not.toHaveBeenCalled();
            expect(pw.pwUnlink).not.toHaveBeenCalled();
            expect(pw.pwUnlinkAllBetween).not.toHaveBeenCalled();
        });

        it('restarts running decoder on UDP teardown (skipModuleRestart=false)', async () => {
            const sinkMod = makeMockModule({ running: true });
            modules.set('sink-mod', sinkMod);

            const handle: ActiveHandle = { connectionId: 'c1', type: 'udp', udpPort: 5004 };
            const conn = makeConnection({ streamType: 'muxed/mpegts' });

            await executor.teardown(handle, conn, false);

            expect(sinkMod.stop).toHaveBeenCalled();
            expect(sinkMod.start).toHaveBeenCalled();
        });

        it('does not restart decoder on UDP teardown when skipModuleRestart=true', async () => {
            const sinkMod = makeMockModule({ running: true });
            modules.set('sink-mod', sinkMod);

            const handle: ActiveHandle = { connectionId: 'c1', type: 'udp', udpPort: 5004 };
            const conn = makeConnection({ streamType: 'muxed/mpegts' });

            await executor.teardown(handle, conn, true);

            expect(sinkMod.stop).not.toHaveBeenCalled();
            expect(sinkMod.start).not.toHaveBeenCalled();
        });

        it('skips decoder restart when sink module is not running', async () => {
            const sinkMod = makeMockModule({ running: false });
            modules.set('sink-mod', sinkMod);

            const handle: ActiveHandle = { connectionId: 'c1', type: 'udp', udpPort: 5004 };
            const conn = makeConnection({ streamType: 'muxed/mpegts' });

            await executor.teardown(handle, conn, false);

            expect(sinkMod.stop).not.toHaveBeenCalled();
            expect(sinkMod.start).not.toHaveBeenCalled();
        });

        it('skips decoder restart when conn is undefined', async () => {
            const handle: ActiveHandle = { connectionId: 'c1', type: 'udp', udpPort: 5004 };

            await executor.teardown(handle, undefined, false);

            // No crash, no module interaction
            expect(pw.unloadModule).not.toHaveBeenCalled();
        });

        it('skips decoder restart when sink module is not found', async () => {
            const handle: ActiveHandle = { connectionId: 'c1', type: 'udp', udpPort: 5004 };
            const conn = makeConnection({ streamType: 'muxed/mpegts' });

            // sink-mod not in modules map
            await executor.teardown(handle, conn, false);

            // Should not crash
        });

        it('handles decoder restart failure gracefully', async () => {
            const sinkMod = makeMockModule({
                running: true,
                stop: vi.fn(async () => { throw new Error('stop failed'); }),
            });
            modules.set('sink-mod', sinkMod);

            const handle: ActiveHandle = { connectionId: 'c1', type: 'udp', udpPort: 5004 };
            const conn = makeConnection({ streamType: 'muxed/mpegts' });

            // Should not throw — best effort
            await executor.teardown(handle, conn, false);
        });
    });

    // --- connLabel ---

    describe('connLabel (via execute logging)', () => {
        it('uses displayNameResolver when provided', async () => {
            // The label is used in logging; we just verify execute works with it.
            // The constructor was given a resolver that uppercases IDs.
            modules.set('src-mod', makeMockModule({
                getPipeWireNodes: vi.fn(() => ({ source: 'src' })),
            }));
            modules.set('sink-mod', makeMockModule({
                getPipeWireNodes: vi.fn(() => ({ sink: 'snk' })),
            }));

            const result = await executor.execute(makeConnection());
            expect(result).not.toBeNull();
        });

        it('works without displayNameResolver', async () => {
            const execNoResolver = new ConnectionExecutor(
                pw as unknown as PipeWireManager,
                (id) => modules.get(id),
                (id) => udpPorts.get(id),
                '239.0.0.1',
            );

            modules.set('src-mod', makeMockModule({
                getPipeWireNodes: vi.fn(() => ({ source: 'src' })),
            }));
            modules.set('sink-mod', makeMockModule({
                getPipeWireNodes: vi.fn(() => ({ sink: 'snk' })),
            }));

            const result = await execNoResolver.execute(makeConnection());
            expect(result).not.toBeNull();
        });
    });
});
