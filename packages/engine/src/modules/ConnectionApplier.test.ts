import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    ConnectionApplier,
    topoSortOrderedConns,
    type StoredConnection,
    type RawPort,
} from './ConnectionApplier.js';

function makeConn(overrides: Partial<StoredConnection> = {}): StoredConnection {
    return {
        id: 'conn-1',
        sourceModuleId: 'src-mod',
        sourcePortId: 'out',
        sinkModuleId: 'sink-mod',
        sinkPortId: 'in',
        ...overrides,
    };
}

function makeModules(
    ids: string[],
    pluginId = 'test-plugin',
): Record<string, Record<string, unknown>> {
    const modules: Record<string, Record<string, unknown>> = {};
    for (const id of ids) modules[id] = { pluginId };
    return modules;
}

describe('ConnectionApplier', () => {
    let mockMediaRouter: {
        createConnection: ReturnType<typeof vi.fn>;
        invalidateOutgoingPwLinks: ReturnType<typeof vi.fn>;
    };
    let mockModuleManager: { get: ReturnType<typeof vi.fn> };
    let resolvePortsForInstance: ReturnType<typeof vi.fn>;
    let getConfig: ReturnType<typeof vi.fn>;
    let applier: ConnectionApplier;

    beforeEach(() => {
        mockMediaRouter = {
            createConnection: vi.fn().mockResolvedValue('conn-id'),
            invalidateOutgoingPwLinks: vi.fn().mockResolvedValue(undefined),
        };
        mockModuleManager = {
            get: vi.fn().mockReturnValue({ running: true }),
        };
        resolvePortsForInstance = vi.fn().mockReturnValue([]);
        getConfig = vi.fn().mockReturnValue(null);

        applier = new ConnectionApplier(
            mockModuleManager as any,
            mockMediaRouter as any,
            getConfig,
            resolvePortsForInstance,
        );
    });

    describe('applyConnections', () => {
        it('applies ordered-apply connections first', async () => {
            const orderedPort: RawPort = {
                id: 'mpegts-out',
                direction: 'output',
                streamType: 'muxed/mpegts',
                requiresOrderedApply: true,
            };
            resolvePortsForInstance.mockReturnValue([orderedPort]);

            const conn = makeConn({ sourcePortId: 'mpegts-out', sinkPortId: 'mpegts-in' });
            const modules = makeModules(['src-mod', 'sink-mod']);

            await applier.applyConnections([conn], modules);

            expect(mockMediaRouter.createConnection).toHaveBeenCalledWith(
                'src-mod',
                'mpegts-out',
                'sink-mod',
                'mpegts-in',
                undefined,
            );
        });

        it('applies non-ordered connections after ordered ones, with settle delay', async () => {
            // Ordered-apply port for encoder module (e.g. muxed/mpegts)
            const orderedPort: RawPort = {
                id: 'mpegts-out',
                direction: 'output',
                streamType: 'muxed/mpegts',
                requiresOrderedApply: true,
            };
            // Plain audio port (no ordered flag) for audio module
            const audioPort: RawPort = {
                id: 'audio-out',
                direction: 'output',
                streamType: 'audio/pcm',
            };

            resolvePortsForInstance.mockImplementation((instanceId: string) => {
                if (instanceId === 'encoder') return [orderedPort];
                if (instanceId === 'audio-src') return [audioPort];
                return [];
            });

            const mpegtsConn = makeConn({
                id: 'mpegts-conn',
                sourceModuleId: 'encoder',
                sourcePortId: 'mpegts-out',
                sinkModuleId: 'decoder',
                sinkPortId: 'mpegts-in',
            });
            const audioConn = makeConn({
                id: 'audio-conn',
                sourceModuleId: 'audio-src',
                sourcePortId: 'audio-out',
                sinkModuleId: 'audio-sink',
                sinkPortId: 'audio-in',
            });

            const modules = makeModules(['encoder', 'decoder', 'audio-src', 'audio-sink']);
            const callOrder: string[] = [];
            mockMediaRouter.createConnection.mockImplementation(async (srcMod: string) => {
                callOrder.push(srcMod);
                return 'conn-id';
            });

            await applier.applyConnections([audioConn, mpegtsConn], modules);

            // Ordered first, then non-ordered
            expect(callOrder).toEqual(['encoder', 'audio-src']);
        });

        it('flag is opt-in: streamType=muxed/mpegts without the flag stays in the non-ordered group', async () => {
            // Documents the decoupling: it's the flag, not the streamType,
            // that drives ordering. A plugin can declare muxed/mpegts without
            // ordered apply and a pw-link plugin can opt in.
            const muxedNoFlag: RawPort = {
                id: 'muxed-out',
                direction: 'output',
                streamType: 'muxed/mpegts',
                // no requiresOrderedApply
            };
            resolvePortsForInstance.mockReturnValue([muxedNoFlag]);

            const conn = makeConn({ sourcePortId: 'muxed-out' });
            const modules = makeModules(['src-mod', 'sink-mod']);
            await applier.applyConnections([conn], modules);

            // It still applies (just in the non-ordered phase). One call total.
            expect(mockMediaRouter.createConnection).toHaveBeenCalledTimes(1);
        });

        it('applies only non-ordered connections without settle delay when no ordered ones', async () => {
            resolvePortsForInstance.mockReturnValue([
                { id: 'audio-out', direction: 'output', streamType: 'audio/pcm' },
            ]);

            const conn = makeConn({ sourcePortId: 'audio-out' });
            const modules = makeModules(['src-mod', 'sink-mod']);

            await applier.applyConnections([conn], modules);

            expect(mockMediaRouter.createConnection).toHaveBeenCalledTimes(1);
        });

        it('does nothing with empty connections array', async () => {
            await applier.applyConnections([], {});

            expect(mockMediaRouter.createConnection).not.toHaveBeenCalled();
            expect(resolvePortsForInstance).not.toHaveBeenCalled();
        });

        it('skips audio connections where endpoints are not running', async () => {
            resolvePortsForInstance.mockReturnValue([
                { id: 'audio-out', direction: 'output', streamType: 'audio/pcm' },
            ]);
            mockModuleManager.get.mockReturnValue({ running: false });

            const conn = makeConn({ sourcePortId: 'audio-out' });
            const modules = makeModules(['src-mod', 'sink-mod']);

            await applier.applyConnections([conn], modules);

            expect(mockMediaRouter.createConnection).not.toHaveBeenCalled();
        });

        it('continues on error for individual connections', async () => {
            resolvePortsForInstance.mockReturnValue([
                { id: 'out', direction: 'output', streamType: 'audio/pcm' },
            ]);

            const conn1 = makeConn({ id: 'c1', sourceModuleId: 'a', sinkModuleId: 'b' });
            const conn2 = makeConn({ id: 'c2', sourceModuleId: 'c', sinkModuleId: 'd' });
            const modules = makeModules(['a', 'b', 'c', 'd']);

            // Fail consistently for c1 (all retries), succeed for c2
            mockMediaRouter.createConnection.mockImplementation(async (srcMod: string) => {
                if (srcMod === 'a') throw new Error('fail');
                return 'ok';
            });

            await applier.applyConnections([conn1, conn2], modules);

            // c1: 1 initial + 2 retries = 3, c2: 1 = total 4
            expect(mockMediaRouter.createConnection).toHaveBeenCalledTimes(4);
            // c2 should still have been attempted (continues after c1 exhausts retries)
            expect(mockMediaRouter.createConnection).toHaveBeenCalledWith(
                'c',
                'out',
                'd',
                'in',
                undefined,
            );
        });

        it('handles mixed ordered and non-ordered connections with correct ordering', async () => {
            resolvePortsForInstance.mockImplementation((instanceId: string) => {
                if (instanceId === 'enc-1')
                    return [
                        {
                            id: 'ts-out',
                            direction: 'output',
                            streamType: 'muxed/mpegts',
                            requiresOrderedApply: true,
                        },
                    ];
                if (instanceId === 'enc-2')
                    return [
                        {
                            id: 'ts-out2',
                            direction: 'output',
                            streamType: 'muxed/mpegts',
                            requiresOrderedApply: true,
                        },
                    ];
                if (instanceId === 'audio-1')
                    return [{ id: 'a-out', direction: 'output', streamType: 'audio/pcm' }];
                return [];
            });

            const ts1 = makeConn({
                id: 'ts1',
                sourceModuleId: 'enc-1',
                sourcePortId: 'ts-out',
                sinkModuleId: 'dec-1',
                sinkPortId: 'ts-in',
            });
            const ts2 = makeConn({
                id: 'ts2',
                sourceModuleId: 'enc-2',
                sourcePortId: 'ts-out2',
                sinkModuleId: 'dec-2',
                sinkPortId: 'ts-in2',
            });
            const audio = makeConn({
                id: 'a1',
                sourceModuleId: 'audio-1',
                sourcePortId: 'a-out',
                sinkModuleId: 'audio-sink',
                sinkPortId: 'a-in',
            });

            const modules = makeModules([
                'enc-1',
                'enc-2',
                'dec-1',
                'dec-2',
                'audio-1',
                'audio-sink',
            ]);
            const callOrder: string[] = [];
            mockMediaRouter.createConnection.mockImplementation(async (srcMod: string) => {
                callOrder.push(srcMod);
                return 'id';
            });

            await applier.applyConnections([audio, ts1, ts2], modules);

            // Both MPEG-TS first, then audio
            expect(callOrder.slice(0, 2)).toEqual(['enc-1', 'enc-2']);
            expect(callOrder[2]).toBe('audio-1');
        });
    });

    describe('topoSortOrderedConns', () => {
        it('orders parent before child so the parent apply triggers the sink-module restart that assigns the child connection\'s source port', () => {
            // Chain: srt → demuxer → decoder
            // Storage order is reversed (decoder→? first, parent last) — sort must fix it.
            const parent = makeConn({
                id: 'parent',
                sourceModuleId: 'srt-input',
                sinkModuleId: 'demuxer',
            });
            const child = makeConn({
                id: 'child',
                sourceModuleId: 'demuxer',
                sinkModuleId: 'decoder',
            });
            const sorted = topoSortOrderedConns([child, parent]);
            expect(sorted.map((c) => c.id)).toEqual(['parent', 'child']);
        });

        it('handles deeper chains', () => {
            // srt → demuxer → muxer → decoder
            const a = makeConn({ id: 'a', sourceModuleId: 'srt', sinkModuleId: 'demuxer' });
            const b = makeConn({ id: 'b', sourceModuleId: 'demuxer', sinkModuleId: 'muxer' });
            const c = makeConn({ id: 'c', sourceModuleId: 'muxer', sinkModuleId: 'decoder' });
            // Worst-case input order
            const sorted = topoSortOrderedConns([c, b, a]);
            expect(sorted.map((x) => x.id)).toEqual(['a', 'b', 'c']);
        });

        it('keeps independent chains in input order', () => {
            // Two disjoint chains: srt1→dec1 and srt2→dec2
            const x = makeConn({ id: 'x', sourceModuleId: 'srt1', sinkModuleId: 'dec1' });
            const y = makeConn({ id: 'y', sourceModuleId: 'srt2', sinkModuleId: 'dec2' });
            const sorted = topoSortOrderedConns([x, y]);
            // Both are roots (sources are not sinks of anything else) — first-found wins
            expect(sorted.map((c) => c.id)).toEqual(['x', 'y']);
        });

        it('falls back to input order for an empty list', () => {
            expect(topoSortOrderedConns([])).toEqual([]);
        });

        it('does not stall on cycles — places cyclic members at the tail', () => {
            // Pathological: A.sink → B, B.sink → A (would imply media flowing in a circle)
            const a = makeConn({ id: 'a', sourceModuleId: 'm1', sinkModuleId: 'm2' });
            const b = makeConn({ id: 'b', sourceModuleId: 'm2', sinkModuleId: 'm1' });
            const sorted = topoSortOrderedConns([a, b]);
            expect(sorted).toHaveLength(2);
        });
    });

    describe('reapplyModuleConnections', () => {
        it('reapplies connections involving the specified module', async () => {
            getConfig.mockReturnValue({
                connections: [
                    makeConn({ id: 'c1', sourceModuleId: 'mod-a', sinkModuleId: 'mod-b' }),
                    makeConn({ id: 'c2', sourceModuleId: 'mod-c', sinkModuleId: 'mod-d' }),
                ],
            });

            await applier.reapplyModuleConnections('mod-a');

            expect(mockMediaRouter.createConnection).toHaveBeenCalledTimes(1);
            expect(mockMediaRouter.createConnection).toHaveBeenCalledWith(
                'mod-a',
                'out',
                'mod-b',
                'in',
                undefined,
            );
        });

        it('reapplies when module is the sink', async () => {
            getConfig.mockReturnValue({
                connections: [
                    makeConn({ id: 'c1', sourceModuleId: 'mod-x', sinkModuleId: 'target' }),
                ],
            });

            await applier.reapplyModuleConnections('target');

            expect(mockMediaRouter.createConnection).toHaveBeenCalledTimes(1);
        });

        it('outgoingOnly=true reapplies source edges but skips the module\'s incoming edges', async () => {
            // The post-consumer-restart cascade path. Re-applying the just-
            // restarted module's *incoming* edges would restart it again and
            // re-fire the cascade — an infinite restart loop (mpegts-muxer:
            // 2 encoder inputs + 1 output). Outgoing-only gives only the
            // module's *downstream* connections a fresh attempt.
            getConfig.mockReturnValue({
                connections: [
                    // incoming: target is the SINK — must be skipped
                    makeConn({
                        id: 'in',
                        sourceModuleId: 'encoder',
                        sourcePortId: 'mpegts-out',
                        sinkModuleId: 'target',
                        sinkPortId: 'video-0',
                    }),
                    // outgoing: target is the SOURCE — must be reapplied
                    makeConn({
                        id: 'out',
                        sourceModuleId: 'target',
                        sourcePortId: 'mpegts-out',
                        sinkModuleId: 'ip-output',
                        sinkPortId: 'mpegts-in',
                    }),
                ],
            });

            await applier.reapplyModuleConnections('target', true);

            expect(mockMediaRouter.createConnection).toHaveBeenCalledTimes(1);
            expect(mockMediaRouter.createConnection).toHaveBeenCalledWith(
                'target',
                'mpegts-out',
                'ip-output',
                'mpegts-in',
                undefined,
            );
            // the incoming edge (encoder -> target) was NOT reapplied
            expect(mockMediaRouter.createConnection).not.toHaveBeenCalledWith(
                'encoder',
                'mpegts-out',
                'target',
                'video-0',
                undefined,
            );
        });

        it('outgoingOnly=true invalidates stale pw-links before re-applying, so the encoder re-links', async () => {
            // The just-restarted consumer recreated its PipeWire null-sink; its
            // outgoing pw-link handle is now stale. Without dropping it first,
            // createConnection short-circuits on "already exists" and the
            // downstream encoder stays silent. invalidate must run BEFORE the
            // re-apply.
            getConfig.mockReturnValue({
                connections: [
                    makeConn({
                        id: 'out',
                        sourceModuleId: 'decoder',
                        sourcePortId: 'audio-out',
                        sinkModuleId: 'encoder',
                        sinkPortId: 'audio-in',
                    }),
                ],
            });
            const order: string[] = [];
            mockMediaRouter.invalidateOutgoingPwLinks.mockImplementation(async () => {
                order.push('invalidate');
            });
            mockMediaRouter.createConnection.mockImplementation(async () => {
                order.push('create');
                return 'conn-id';
            });

            await applier.reapplyModuleConnections('decoder', true);

            expect(mockMediaRouter.invalidateOutgoingPwLinks).toHaveBeenCalledWith('decoder');
            expect(order).toEqual(['invalidate', 'create']);
        });

        it('outgoingOnly=false (normal restart) does NOT invalidate pw-links', async () => {
            // The full _restart path already removed the module's own edges
            // before re-applying, so there is no stale handle to clear.
            getConfig.mockReturnValue({
                connections: [makeConn({ sourceModuleId: 'mod-a', sinkModuleId: 'mod-b' })],
            });

            await applier.reapplyModuleConnections('mod-a');

            expect(mockMediaRouter.invalidateOutgoingPwLinks).not.toHaveBeenCalled();
        });

        it('skips connections where source or sink is not running', async () => {
            getConfig.mockReturnValue({
                connections: [makeConn({ sourceModuleId: 'mod-a', sinkModuleId: 'mod-b' })],
            });
            mockModuleManager.get.mockImplementation((id: string) => {
                if (id === 'mod-a') return { running: true };
                return { running: false };
            });

            await applier.reapplyModuleConnections('mod-a');

            expect(mockMediaRouter.createConnection).not.toHaveBeenCalled();
        });

        it('does nothing when config is null', async () => {
            getConfig.mockReturnValue(null);

            await applier.reapplyModuleConnections('mod-a');

            expect(mockMediaRouter.createConnection).not.toHaveBeenCalled();
        });

        it('continues on error for individual connections', async () => {
            getConfig.mockReturnValue({
                connections: [
                    makeConn({ id: 'c1', sourceModuleId: 'target', sinkModuleId: 'mod-b' }),
                    makeConn({
                        id: 'c2',
                        sourceModuleId: 'target',
                        sinkModuleId: 'mod-c',
                        sourcePortId: 'out2',
                        sinkPortId: 'in2',
                    }),
                ],
            });

            // Fail consistently for c1 (all retries), succeed for c2
            mockMediaRouter.createConnection.mockImplementation(
                async (_src: string, _sp: string, sink: string) => {
                    if (sink === 'mod-b') throw new Error('fail');
                    return 'ok';
                },
            );

            await applier.reapplyModuleConnections('target');

            // c1: 1 initial + 2 retries = 3, c2: 1 = total 4
            expect(mockMediaRouter.createConnection).toHaveBeenCalledTimes(4);
            // c2 still attempted
            expect(mockMediaRouter.createConnection).toHaveBeenCalledWith(
                'target',
                'out2',
                'mod-c',
                'in2',
                undefined,
            );
        });

        it('handles config with no connections key', async () => {
            getConfig.mockReturnValue({});

            await applier.reapplyModuleConnections('mod-a');

            expect(mockMediaRouter.createConnection).not.toHaveBeenCalled();
        });
    });

    // A validation reject used to leave the sink up, healthy-looking and
    // silent, with the reason only in the engine journal (2026-07-23
    // transcoder DEPLOY NOTE). Fake timers here so exhausting the retry
    // backoff costs no wall time.
    describe('reject warnings on the sink', () => {
        let setHealth: ReturnType<typeof vi.fn>;

        beforeEach(() => {
            vi.useFakeTimers();
            setHealth = vi.fn();
            mockModuleManager.get = vi.fn().mockReturnValue({ running: true, setHealth });
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        /** Run applyConnections to completion, driving the retry backoff. */
        async function applyAll(conns: StoredConnection[], mods: string[]): Promise<void> {
            const done = applier.applyConnections(conns, makeModules(mods));
            await vi.advanceTimersByTimeAsync(30_000);
            await done;
        }

        it('warns on the sink when the input refuses the source stream type', async () => {
            mockMediaRouter.createConnection.mockRejectedValue(
                new Error('Incompatible ports: Port accepts only muxed/mpegts — got audio/302m'),
            );

            await applyAll([makeConn({ sourceModuleId: 'ts-split-1', sourcePortId: 'out' })], [
                'ts-split-1',
                'sink-mod',
            ]);

            expect(setHealth).toHaveBeenCalledWith(
                'warning',
                'Not connected: Port accepts only muxed/mpegts — got audio/302m (from ts-split-1:out)',
            );
        });

        it('warns when a port is already at capacity', async () => {
            mockMediaRouter.createConnection.mockRejectedValue(
                new Error('Port in already has 1/1 connections'),
            );

            await applyAll([makeConn()], ['src-mod', 'sink-mod']);

            expect(setHealth).toHaveBeenCalledWith(
                'warning',
                'Not connected: Port in already has 1/1 connections (from src-mod:out)',
            );
        });

        it('stays quiet for a transient failure that merely ran out of retries', async () => {
            mockMediaRouter.createConnection.mockRejectedValue(
                new Error('pw-link failed: node not found'),
            );

            await applyAll([makeConn()], ['src-mod', 'sink-mod']);

            expect(setHealth).not.toHaveBeenCalled();
        });

        it('warns once when several connections into one sink are refused', async () => {
            mockMediaRouter.createConnection.mockRejectedValue(
                new Error('Incompatible ports: Stream type mismatch: audio/pcm → video/raw'),
            );

            await applyAll(
                [
                    makeConn({ id: 'c1', sourceModuleId: 'a' }),
                    makeConn({ id: 'c2', sourceModuleId: 'b' }),
                ],
                ['a', 'b', 'sink-mod'],
            );

            const warnings = setHealth.mock.calls.filter((c) => c[0] === 'warning');
            expect(warnings).toHaveLength(1);
        });

        it('clears the warning when a later connection into that sink succeeds', async () => {
            mockMediaRouter.createConnection.mockRejectedValue(
                new Error('Incompatible ports: Channel mismatch: 2 → 8'),
            );
            await applyAll([makeConn()], ['src-mod', 'sink-mod']);
            expect(setHealth).toHaveBeenCalledWith('warning', expect.stringContaining('2 → 8'));

            setHealth.mockClear();
            mockMediaRouter.createConnection.mockResolvedValue('conn-id');
            await applyAll([makeConn()], ['src-mod', 'sink-mod']);

            expect(setHealth).toHaveBeenCalledWith('ok');
        });

        // Blanket-clearing to 'ok' on every success would wipe health this
        // applier never set — e.g. GstPluginBase's "Waiting for producer bus
        // socket(s)" warning on the very same module.
        it('does not touch health on success when it never warned', async () => {
            mockMediaRouter.createConnection.mockResolvedValue('conn-id');

            await applyAll([makeConn()], ['src-mod', 'sink-mod']);

            expect(setHealth).not.toHaveBeenCalled();
        });
    });
});
