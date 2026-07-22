import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConnectionExecutor } from './ConnectionExecutor.js';
import { PcmAudioExecutor } from './PcmAudioExecutor.js';
import { MpegTsBusExecutor } from './MpegTsBusExecutor.js';
import { StreamTypeExecutorRegistry, makeConnLabel } from './StreamTypeExecutor.js';
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
    let busChannels: Map<string, number>;
    let executor: ConnectionExecutor;

    beforeEach(() => {
        pw = makeMockPipeWire();
        modules = new Map();
        busChannels = new Map();
        const moduleGetter = (id: string) => modules.get(id);
        const getUdpPort = (id: string) => busChannels.get(id);
        const connLabel = makeConnLabel((id) => id.toUpperCase());
        const registry = new StreamTypeExecutorRegistry();
        registry.register(
            new PcmAudioExecutor(pw as unknown as PipeWireManager, moduleGetter, connLabel),
        );
        registry.register(
            new MpegTsBusExecutor(moduleGetter, getUdpPort, connLabel),
        );
        executor = new ConnectionExecutor(registry);
    });

    // --- execute() dispatch ---

    describe('execute()', () => {
        it('returns null for unknown stream type', async () => {
            const conn = makeConnection({ streamType: 'video/raw' as any });
            const result = await executor.execute(conn);
            expect(result).toBeNull();
        });

        it('dispatches audio/pcm to pw-link with identity mapping', async () => {
            const srcMod = makeMockModule({
                getPipeWireNodes: vi.fn(() => ({ source: 'mic-node' })),
            });
            const sinkMod = makeMockModule({
                getPipeWireNodes: vi.fn(() => ({ sink: 'encoder-node' })),
            });
            modules.set('src-mod', srcMod);
            modules.set('sink-mod', sinkMod);

            pw.listPorts.mockImplementation((node: string, dir: string) => {
                if (dir === 'output') return ['mic-node:output_FL', 'mic-node:output_FR'];
                return ['encoder-node:input_FL', 'encoder-node:input_FR'];
            });

            const conn = makeConnection();
            const result = await executor.execute(conn);

            expect(result).toEqual({
                connectionId: conn.id,
                type: 'pw-link',
                pwLinkIds: [100, 100],
                pwLinkPairs: [
                    { src: 'mic-node:output_FL', dst: 'encoder-node:input_FL' },
                    { src: 'mic-node:output_FR', dst: 'encoder-node:input_FR' },
                ],
            });
            expect(pw.pwUnlinkAllBetween).toHaveBeenCalledWith('mic-node', 'encoder-node');
            expect(pw.pwLink).toHaveBeenCalledTimes(2);
        });

        it('dispatches muxed/mpegts to the bus', async () => {
            const sinkMod = makeMockModule();
            modules.set('sink-mod', sinkMod);
            busChannels.set('src-mod', 5004);

            const conn = makeConnection({ streamType: 'muxed/mpegts' });
            const result = await executor.execute(conn);

            expect(result).toEqual({
                connectionId: conn.id,
                type: 'bus',
                busChannel: 5004,
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
            modules.set(
                'src-mod',
                makeMockModule({
                    getPipeWireNodes: vi.fn(() => ({ sink: 'only-sink' })),
                }),
            );
            modules.set(
                'sink-mod',
                makeMockModule({
                    getPipeWireNodes: vi.fn(() => ({ sink: 'sink-node' })),
                }),
            );
            const result = await executor.execute(makeConnection());
            expect(result).toBeNull();
        });

        it('returns null when sink has no PipeWire sink node', async () => {
            modules.set(
                'src-mod',
                makeMockModule({
                    getPipeWireNodes: vi.fn(() => ({ source: 'src-node' })),
                }),
            );
            modules.set(
                'sink-mod',
                makeMockModule({
                    getPipeWireNodes: vi.fn(() => ({ source: 'only-source' })),
                }),
            );
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

            pw.listPorts.mockImplementation((node: string, dir: string) => {
                if (dir === 'output') return ['port-specific-src:output_FL'];
                return ['port-specific-sink:input_FL'];
            });

            await executor.execute(makeConnection());

            expect(pw.pwUnlinkAllBetween).toHaveBeenCalledWith(
                'port-specific-src',
                'port-specific-sink',
            );
            expect(pw.pwLink).toHaveBeenCalledWith(
                'port-specific-src:output_FL',
                'port-specific-sink:input_FL',
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

            pw.listPorts.mockImplementation((node: string, dir: string) => {
                if (dir === 'output') return ['module-src:output_FL'];
                return ['module-sink:input_FL'];
            });

            await executor.execute(makeConnection());

            expect(pw.pwUnlinkAllBetween).toHaveBeenCalledWith('module-src', 'module-sink');
            expect(pw.pwLink).toHaveBeenCalledWith('module-src:output_FL', 'module-sink:input_FL');
        });

        it('creates pw-link identity mapping for audio/pcm without channelMap', async () => {
            modules.set(
                'src-mod',
                makeMockModule({
                    getPipeWireNodes: vi.fn(() => ({ source: 'mic' })),
                }),
            );
            modules.set(
                'sink-mod',
                makeMockModule({
                    getPipeWireNodes: vi.fn(() => ({ sink: 'enc' })),
                }),
            );

            pw.listPorts.mockImplementation((node: string, dir: string) => {
                if (dir === 'output') return ['mic:output_FL', 'mic:output_FR'];
                return ['enc:input_FL', 'enc:input_FR'];
            });

            const result = await executor.execute(makeConnection());

            expect(result).toEqual({
                connectionId: 'src:out-sink:in',
                type: 'pw-link',
                pwLinkIds: [100, 100],
                pwLinkPairs: [
                    { src: 'mic:output_FL', dst: 'enc:input_FL' },
                    { src: 'mic:output_FR', dst: 'enc:input_FR' },
                ],
            });
        });

        it('identity mapping uses min(src, dst) channels', async () => {
            modules.set(
                'src-mod',
                makeMockModule({
                    getPipeWireNodes: vi.fn(() => ({ source: 'src8ch' })),
                }),
            );
            modules.set(
                'sink-mod',
                makeMockModule({
                    getPipeWireNodes: vi.fn(() => ({ sink: 'sink2ch' })),
                }),
            );

            pw.listPorts.mockImplementation((node: string, dir: string) => {
                if (dir === 'output')
                    return [
                        'src8ch:out_0',
                        'src8ch:out_1',
                        'src8ch:out_2',
                        'src8ch:out_3',
                        'src8ch:out_4',
                        'src8ch:out_5',
                        'src8ch:out_6',
                        'src8ch:out_7',
                    ];
                return ['sink2ch:in_0', 'sink2ch:in_1'];
            });

            const result = await executor.execute(makeConnection());

            // Only 2 links created (limited by sink's 2 channels)
            expect(pw.pwLink).toHaveBeenCalledTimes(2);
            expect(result!.pwLinkPairs).toHaveLength(2);
        });
    });

    // --- executePwLink (channelMap) ---

    describe('executePwLink (audio/pcm with channelMap)', () => {
        function setupPwLinkModules() {
            modules.set(
                'src-mod',
                makeMockModule({
                    getPipeWireNodes: vi.fn(() => ({ source: 'src-node' })),
                }),
            );
            modules.set(
                'sink-mod',
                makeMockModule({
                    getPipeWireNodes: vi.fn(() => ({ sink: 'sink-node' })),
                }),
            );
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

        it('falls back to identity mapping when all channelMap entries are out of range', async () => {
            setupPwLinkModules();
            const conn = makeConnection({
                channelMap: [{ srcChannel: 5, dstChannel: 0 }],
            });

            const result = await executor.execute(conn);

            // All entries invalid → falls back to identity mapping (2 stereo links)
            expect(pw.pwLink).toHaveBeenCalledTimes(2);
            expect(result!.pwLinkIds).toHaveLength(2);
        });

        it('filters out-of-range entries and keeps valid ones', async () => {
            setupPwLinkModules();
            const conn = makeConnection({
                channelMap: [
                    { srcChannel: 0, dstChannel: 0 }, // valid
                    { srcChannel: 5, dstChannel: 1 }, // src out of range
                    { srcChannel: 0, dstChannel: 5 }, // dst out of range
                ],
            });

            const result = await executor.execute(conn);

            // Only 1 valid entry
            expect(pw.pwLink).toHaveBeenCalledTimes(1);
            expect(pw.pwLink).toHaveBeenCalledWith('src-node:output_FL', 'sink-node:input_FL');
            expect(result!.pwLinkIds).toEqual([100]);
        });

        it('handles pwLink failure gracefully and continues', async () => {
            setupPwLinkModules();
            pw.pwLink.mockImplementationOnce(() => {
                throw new Error('link failed');
            });
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

    // --- MpegTsBusExecutor.execute ---

    describe('bus execute (muxed/mpegts)', () => {
        it('returns null when decoder module is missing', async () => {
            busChannels.set('src-mod', 5004);
            const result = await executor.execute(makeConnection({ streamType: 'muxed/mpegts' }));
            expect(result).toBeNull();
        });

        it('throws when producer has no assigned bus channel — caller (ConnectionApplier) retries once the producer is up', async () => {
            modules.set('sink-mod', makeMockModule());
            await expect(
                executor.execute(makeConnection({ streamType: 'muxed/mpegts' })),
            ).rejects.toThrow(/has not assigned a bus channel/);
        });

        function makeMockProducer(overrides: Partial<ModuleInstance> = {}): ModuleInstance {
            // Live-pipeline producer declaring the connection's source port —
            // the mid-run discovery case materializeProducerPort exists for.
            return makeMockModule({
                running: true,
                getChildProcess: vi.fn(() => ({}) as any),
                getDynamicPorts: vi.fn(() => [
                    { id: 'out', direction: 'output', streamType: 'muxed/mpegts', label: 'Out' },
                ]),
                ...overrides,
            } as Partial<ModuleInstance>);
        }

        it('restarts a running producer whose declared port has no bus allocation yet, then connects', async () => {
            const producer = makeMockProducer({
                start: vi.fn(async () => {
                    busChannels.set('src-mod', 5004);
                }),
            });
            modules.set('src-mod', producer);
            modules.set('sink-mod', makeMockModule());

            const result = await executor.execute(makeConnection({ streamType: 'muxed/mpegts' }));

            expect(producer.stop).toHaveBeenCalled();
            expect(producer.start).toHaveBeenCalled();
            expect(result).toEqual({
                connectionId: 'src:out-sink:in',
                type: 'bus',
                busChannel: 5004,
            });
        });

        it('does not restart a producer that does not declare the port — throws for the retry path', async () => {
            const producer = makeMockProducer({ getDynamicPorts: vi.fn(() => []) });
            modules.set('src-mod', producer);
            modules.set('sink-mod', makeMockModule());

            await expect(
                executor.execute(makeConnection({ streamType: 'muxed/mpegts' })),
            ).rejects.toThrow(/has not assigned a bus channel/);
            expect(producer.stop).not.toHaveBeenCalled();
        });

        it('does not restart a running-but-idle producer (no live pipeline)', async () => {
            // buildPipeline returned null (e.g. demuxer with upstream
            // disconnected): a rebuild would return null again.
            const producer = makeMockProducer({ getChildProcess: vi.fn(() => null) });
            modules.set('src-mod', producer);
            modules.set('sink-mod', makeMockModule());

            await expect(
                executor.execute(makeConnection({ streamType: 'muxed/mpegts' })),
            ).rejects.toThrow(/has not assigned a bus channel/);
            expect(producer.stop).not.toHaveBeenCalled();
        });

        it('falls through to the retry throw when the producer restart fails', async () => {
            const producer = makeMockProducer({
                start: vi.fn(async () => {
                    throw new Error('boom');
                }),
            });
            modules.set('src-mod', producer);
            modules.set('sink-mod', makeMockModule());

            await expect(
                executor.execute(makeConnection({ streamType: 'muxed/mpegts' })),
            ).rejects.toThrow(/has not assigned a bus channel/);
        });

        it('restarts the producer at most once per connection across retries', async () => {
            // Rebuild runs but never yields the port (e.g. stream vanished
            // from config): the retrying caller must not bounce the producer
            // — and its healthy consumers — on every attempt.
            const producer = makeMockProducer();
            modules.set('src-mod', producer);
            modules.set('sink-mod', makeMockModule());
            const conn = makeConnection({ streamType: 'muxed/mpegts' });

            await expect(executor.execute(conn)).rejects.toThrow(/has not assigned a bus channel/);
            await expect(executor.execute(conn)).rejects.toThrow(/has not assigned a bus channel/);
            expect(producer.stop).toHaveBeenCalledTimes(1);
        });

        it('stops and restarts a running decoder', async () => {
            const sinkMod = makeMockModule({ running: true });
            modules.set('sink-mod', sinkMod);
            busChannels.set('src-mod', 5004);

            await executor.execute(makeConnection({ streamType: 'muxed/mpegts' }));

            expect(sinkMod.stop).toHaveBeenCalled();
            expect(sinkMod.start).toHaveBeenCalled();
        });

        it('starts a non-running decoder without stopping first', async () => {
            const sinkMod = makeMockModule({ running: false });
            modules.set('sink-mod', sinkMod);
            busChannels.set('src-mod', 5004);

            await executor.execute(makeConnection({ streamType: 'muxed/mpegts' }));

            expect(sinkMod.stop).not.toHaveBeenCalled();
            expect(sinkMod.start).toHaveBeenCalled();
        });

        it('returns handle even when decoder start fails', async () => {
            const sinkMod = makeMockModule({
                start: vi.fn(async () => {
                    throw new Error('start failed');
                }),
            });
            modules.set('sink-mod', sinkMod);
            busChannels.set('src-mod', 5004);

            const result = await executor.execute(makeConnection({ streamType: 'muxed/mpegts' }));

            expect(result).toEqual({
                connectionId: 'src:out-sink:in',
                type: 'bus',
                busChannel: 5004,
            });
        });
    });

    // --- teardown ---

    describe('teardown()', () => {
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
            expect(pw.pwUnlinkByName).toHaveBeenCalledWith(
                'src-node:output_FL',
                'sink-node:input_FL',
            );
            expect(pw.pwUnlinkByName).toHaveBeenCalledWith(
                'src-node:output_FR',
                'sink-node:input_FR',
            );

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
                pwLinkPairs: [{ src: 'src-node:output_FL', dst: 'sink-node:input_FL' }],
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

        it('restarts running decoder on bus teardown (skipModuleRestart=false)', async () => {
            const sinkMod = makeMockModule({ running: true });
            modules.set('sink-mod', sinkMod);

            const handle: ActiveHandle = { connectionId: 'c1', type: 'bus', busChannel: 5004 };
            const conn = makeConnection({ streamType: 'muxed/mpegts' });

            await executor.teardown(handle, conn, false);

            expect(sinkMod.stop).toHaveBeenCalled();
            expect(sinkMod.start).toHaveBeenCalled();
        });

        it('does not restart decoder on bus teardown when skipModuleRestart=true', async () => {
            const sinkMod = makeMockModule({ running: true });
            modules.set('sink-mod', sinkMod);

            const handle: ActiveHandle = { connectionId: 'c1', type: 'bus', busChannel: 5004 };
            const conn = makeConnection({ streamType: 'muxed/mpegts' });

            await executor.teardown(handle, conn, true);

            expect(sinkMod.stop).not.toHaveBeenCalled();
            expect(sinkMod.start).not.toHaveBeenCalled();
        });

        it('skips decoder restart when sink module is not running', async () => {
            const sinkMod = makeMockModule({ running: false });
            modules.set('sink-mod', sinkMod);

            const handle: ActiveHandle = { connectionId: 'c1', type: 'bus', busChannel: 5004 };
            const conn = makeConnection({ streamType: 'muxed/mpegts' });

            await executor.teardown(handle, conn, false);

            expect(sinkMod.stop).not.toHaveBeenCalled();
            expect(sinkMod.start).not.toHaveBeenCalled();
        });

        it('skips decoder restart when conn is undefined', async () => {
            const handle: ActiveHandle = { connectionId: 'c1', type: 'bus', busChannel: 5004 };

            await executor.teardown(handle, undefined, false);

            // No crash, no module interaction
            expect(pw.unloadModule).not.toHaveBeenCalled();
        });

        it('skips decoder restart when sink module is not found', async () => {
            const handle: ActiveHandle = { connectionId: 'c1', type: 'bus', busChannel: 5004 };
            const conn = makeConnection({ streamType: 'muxed/mpegts' });

            // sink-mod not in modules map
            await executor.teardown(handle, conn, false);

            // Should not crash
        });

        it('handles decoder restart failure gracefully', async () => {
            const sinkMod = makeMockModule({
                running: true,
                stop: vi.fn(async () => {
                    throw new Error('stop failed');
                }),
            });
            modules.set('sink-mod', sinkMod);

            const handle: ActiveHandle = { connectionId: 'c1', type: 'bus', busChannel: 5004 };
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
            modules.set(
                'src-mod',
                makeMockModule({
                    getPipeWireNodes: vi.fn(() => ({ source: 'src' })),
                }),
            );
            modules.set(
                'sink-mod',
                makeMockModule({
                    getPipeWireNodes: vi.fn(() => ({ sink: 'snk' })),
                }),
            );

            const result = await executor.execute(makeConnection());
            expect(result).not.toBeNull();
        });

        it('works without displayNameResolver', async () => {
            const moduleGetter = (id: string) => modules.get(id);
            const getUdpPort = (id: string) => busChannels.get(id);
            const connLabel = makeConnLabel(); // no resolver
            const registry = new StreamTypeExecutorRegistry();
            registry.register(
                new PcmAudioExecutor(
                    pw as unknown as PipeWireManager,
                    moduleGetter,
                    connLabel,
                ),
            );
            registry.register(
                new MpegTsBusExecutor(moduleGetter, getUdpPort, '239.0.0.1', connLabel),
            );
            const execNoResolver = new ConnectionExecutor(registry);

            modules.set(
                'src-mod',
                makeMockModule({
                    getPipeWireNodes: vi.fn(() => ({ source: 'src' })),
                }),
            );
            modules.set(
                'sink-mod',
                makeMockModule({
                    getPipeWireNodes: vi.fn(() => ({ sink: 'snk' })),
                }),
            );

            const result = await execNoResolver.execute(makeConnection());
            expect(result).not.toBeNull();
        });
    });
});
