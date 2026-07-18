import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MediaRouter } from './MediaRouter.js';
import type { ModulePort } from '@media-router/shared-types';

/** Helper to register a standard audio source + sink pair. */
function registerAudioPair(router: MediaRouter, srcId = 'a', sinkId = 'b') {
    router.registerPorts(srcId, [
        { id: 'out', direction: 'output', streamType: 'audio/pcm', label: 'Out' },
    ]);
    router.registerPorts(sinkId, [
        { id: 'in', direction: 'input', streamType: 'audio/pcm', label: 'In' },
    ]);
}

function registerMpegtsPair(router: MediaRouter, srcId = 'encoder', sinkId = 'decoder') {
    router.registerPorts(srcId, [
        { id: 'mpegts-out', direction: 'output', streamType: 'muxed/mpegts', label: 'Out' },
    ]);
    router.registerPorts(sinkId, [
        { id: 'mpegts-in', direction: 'input', streamType: 'muxed/mpegts', label: 'In' },
    ]);
}

describe('MediaRouter', () => {
    let router: MediaRouter;

    beforeEach(() => {
        router = new MediaRouter();
    });

    it('registers and retrieves ports', () => {
        const ports: ModulePort[] = [
            { id: 'audio-out', direction: 'output', streamType: 'audio/pcm', label: 'Audio Out' },
        ];
        router.registerPorts('mod-1', ports);
        expect(router.getPort('mod-1', 'audio-out')).toEqual(ports[0]);
    });

    it('creates a valid connection', async () => {
        router.registerPorts('encoder', [
            { id: 'mpegts-out', direction: 'output', streamType: 'muxed/mpegts', label: 'Out' },
        ]);
        router.registerPorts('srt-output', [
            { id: 'mpegts-in', direction: 'input', streamType: 'muxed/mpegts', label: 'In' },
        ]);

        const connId = await router.createConnection(
            'encoder',
            'mpegts-out',
            'srt-output',
            'mpegts-in',
        );
        expect(connId).toBe('encoder:mpegts-out-srt-output:mpegts-in');
        expect(router.getConnections()).toHaveLength(1);
    });

    it('rejects incompatible stream types', async () => {
        router.registerPorts('audio', [
            { id: 'out', direction: 'output', streamType: 'audio/pcm', label: 'Out' },
        ]);
        router.registerPorts('srt', [
            { id: 'in', direction: 'input', streamType: 'muxed/mpegts', label: 'In' },
        ]);

        await expect(router.createConnection('audio', 'out', 'srt', 'in')).rejects.toThrow(
            'Stream type mismatch',
        );
    });

    it('rejects wrong port direction', async () => {
        router.registerPorts('mod-a', [
            { id: 'in', direction: 'input', streamType: 'audio/pcm', label: 'In' },
        ]);
        router.registerPorts('mod-b', [
            { id: 'in', direction: 'input', streamType: 'audio/pcm', label: 'In' },
        ]);

        await expect(router.createConnection('mod-a', 'in', 'mod-b', 'in')).rejects.toThrow(
            'not an output',
        );
    });

    it('removes a connection', async () => {
        router.registerPorts('a', [
            { id: 'out', direction: 'output', streamType: 'audio/pcm', label: 'Out' },
        ]);
        router.registerPorts('b', [
            { id: 'in', direction: 'input', streamType: 'audio/pcm', label: 'In' },
        ]);

        const connId = await router.createConnection('a', 'out', 'b', 'in');
        expect(router.getConnections()).toHaveLength(1);

        await router.removeConnection(connId);
        expect(router.getConnections()).toHaveLength(0);
    });

    it('unregisters ports and removes related connections', async () => {
        router.registerPorts('a', [
            { id: 'out', direction: 'output', streamType: 'audio/pcm', label: 'Out' },
        ]);
        router.registerPorts('b', [
            { id: 'in', direction: 'input', streamType: 'audio/pcm', label: 'In' },
        ]);
        await router.createConnection('a', 'out', 'b', 'in');

        await router.unregisterPorts('a');
        expect(router.getConnections()).toHaveLength(0);
        expect(router.getPort('a', 'out')).toBeUndefined();
    });

    it('validates audio channel compatibility', () => {
        const src: ModulePort = {
            id: 'out',
            direction: 'output',
            streamType: 'audio/pcm',
            channelConfig: { channels: 2 },
            label: 'Stereo Out',
        };
        const sink: ModulePort = {
            id: 'in',
            direction: 'input',
            streamType: 'audio/pcm',
            channelConfig: { channels: 6 },
            label: '5.1 In',
        };

        const result = router.portRegistry.validateCompatibility(src, sink);
        expect(result.compatible).toBe(false);
        expect(result.reason).toContain('Channel mismatch');
    });

    // --- removeConnection ---

    it('removeConnection returns false for non-existent connection', async () => {
        const existed = await router.removeConnection('does-not-exist');
        expect(existed).toBe(false);
    });

    it('removeConnection returns true and clears the connection', async () => {
        registerAudioPair(router);
        const connId = await router.createConnection('a', 'out', 'b', 'in');

        const existed = await router.removeConnection(connId);
        expect(existed).toBe(true);
        expect(router.getConnections()).toHaveLength(0);
    });

    // --- updateChannelMap ---

    it('updateChannelMap is a no-op for non-existent connection', async () => {
        // Should not throw
        await router.updateChannelMap('no-such-conn', [{ sourceChannel: 0, sinkChannel: 0 }]);
    });

    it('updateChannelMap warns for non-audio connection', async () => {
        registerMpegtsPair(router);
        const connId = await router.createConnection(
            'encoder',
            'mpegts-out',
            'decoder',
            'mpegts-in',
        );

        // Should not throw — just logs a warning and returns
        await router.updateChannelMap(connId, [{ sourceChannel: 0, sinkChannel: 0 }]);

        // Connection still exists unchanged
        const conns = router.getConnections();
        expect(conns).toHaveLength(1);
        expect(conns[0].channelMap).toBeUndefined();
    });

    it('updateChannelMap updates channelMap on audio connection', async () => {
        registerAudioPair(router);
        const connId = await router.createConnection('a', 'out', 'b', 'in');

        const newMap = [{ sourceChannel: 0, sinkChannel: 1 }];
        await router.updateChannelMap(connId, newMap);

        const conn = router.getConnections().find((c) => c.id === connId);
        expect(conn?.channelMap).toEqual(newMap);
    });

    it('updateChannelMap clears channelMap when given empty array', async () => {
        registerAudioPair(router);
        const connId = await router.createConnection('a', 'out', 'b', 'in', [
            { sourceChannel: 0, sinkChannel: 0 },
        ]);

        await router.updateChannelMap(connId, []);

        const conn = router.getConnections().find((c) => c.id === connId);
        expect(conn?.channelMap).toBeUndefined();
    });

    // --- removeAllConnections ---

    it('removeAllConnections removes all connections', async () => {
        registerAudioPair(router, 'a', 'b');
        router.registerPorts('c', [
            { id: 'out', direction: 'output', streamType: 'audio/pcm', label: 'Out' },
        ]);
        router.registerPorts('d', [
            { id: 'in', direction: 'input', streamType: 'audio/pcm', label: 'In' },
        ]);

        await router.createConnection('a', 'out', 'b', 'in');
        await router.createConnection('c', 'out', 'd', 'in');
        expect(router.getConnections()).toHaveLength(2);

        await router.removeAllConnections();
        expect(router.getConnections()).toHaveLength(0);
    });

    it('removeAllConnections is a no-op when no connections exist', async () => {
        await router.removeAllConnections();
        expect(router.getConnections()).toHaveLength(0);
    });

    // --- getModuleUdpSource ---

    it('getModuleUdpSource returns undefined when no MPEG-TS connection exists', () => {
        expect(router.getModuleUdpSource('decoder')).toBeUndefined();
    });

    it('getModuleUdpSource finds upstream encoder for a decoder', async () => {
        registerMpegtsPair(router);

        // Set up dependencies with a module getter that returns config + lifecycle
        const mockModuleGetter = vi.fn().mockImplementation((id: string) => {
            if (id === 'encoder') return { config: { codec: 'opus', channels: 2 }, running: false };
            if (id === 'decoder')
                return { config: {}, running: false, stop: vi.fn(), start: vi.fn() };
            return undefined;
        });
        router.setDependencies({} as any, mockModuleGetter);

        // Assign an encoder port
        const endpoint = router.assignUdpPort('encoder');
        expect(endpoint).not.toBeNull();

        // Create the MPEG-TS connection
        await router.createConnection('encoder', 'mpegts-out', 'decoder', 'mpegts-in');

        const source = router.getModuleUdpSource('decoder');
        expect(source).toBeDefined();
        expect(source!.host).toBe('239.255.0.1');
        expect(source!.port).toBe(endpoint!.port);
        expect(source!.channels).toBe(2);
        expect(source!.connectionId).toBe('encoder:mpegts-out-decoder:mpegts-in');
    });

    it('getModuleUdpSource(s) resolve audio/302m connections (TS-family bus type)', async () => {
        router.registerPorts('atx', [
            { id: 'out-0', direction: 'output', streamType: 'audio/302m', label: 'PCM 302M' },
        ]);
        router.registerPorts('aout', [
            {
                id: 'audio-in',
                direction: 'input',
                streamType: 'audio/302m',
                label: 'In',
                maxConnections: -1,
            },
        ]);
        router.setDependencies({} as any, (id: string) =>
            id === 'aout'
                ? ({ config: {}, running: false, stop: vi.fn(), start: vi.fn() } as any)
                : ({ config: {}, running: false } as any),
        );
        const ep = router.assignUdpPort('atx', 'out-0');
        expect(ep).not.toBeNull();
        await router.createConnection('atx', 'out-0', 'aout', 'audio-in');

        const single = router.getModuleUdpSource('aout');
        expect(single).toBeDefined();
        expect(single!.port).toBe(ep!.port);
        expect(single!.streamType).toBe('audio/302m');

        const all = router.getModuleUdpSources('aout');
        expect(all).toHaveLength(1);
        expect(all[0].sinkPortId).toBe('audio-in');
        expect(all[0].streamType).toBe('audio/302m');
    });

    it('updateChannelMap accepts audio/302m edges and exposes the map via getModuleUdpSources', async () => {
        router.registerPorts('atx', [
            { id: 'out-0', direction: 'output', streamType: 'audio/302m', label: 'PCM 302M' },
        ]);
        router.registerPorts('aout', [
            {
                id: 'audio-in',
                direction: 'input',
                streamType: 'audio/302m',
                label: 'In',
                maxConnections: -1,
            },
        ]);
        router.setDependencies({} as any, (id: string) =>
            id === 'aout'
                ? ({ config: {}, running: false, stop: vi.fn(), start: vi.fn() } as any)
                : ({ config: {}, running: false } as any),
        );
        router.assignUdpPort('atx', 'out-0');
        const connId = await router.createConnection('atx', 'out-0', 'aout', 'audio-in');

        const map = [
            { srcChannel: 0, dstChannel: 0, gain: 0.5 },
            { srcChannel: 1, dstChannel: 0, gain: 0.5 },
        ];
        await router.updateChannelMap(connId, map);
        expect(router.getModuleUdpSources('aout')[0].channelMap).toEqual(map);
    });

    it('getModuleUdpSource returns undefined when encoder has no UDP port', async () => {
        registerMpegtsPair(router);

        router.setDependencies({} as any, () => undefined);
        await router.createConnection('encoder', 'mpegts-out', 'decoder', 'mpegts-in');

        // No encoder port assigned — should return undefined
        expect(router.getModuleUdpSource('decoder')).toBeUndefined();
    });

    it('createConnection rethrows when executor.execute throws — and removes the zombie connection', async () => {
        // Regression guard for the connection-ordering fix: applying a
        // child MPEG-TS connection before its parent races on the source's
        // UDP-port assignment. ConnectionExecutor.executeUdp throws in that
        // case; MediaRouter must surface that throw to ConnectionApplier so
        // the retry path (connectWithRetry / topoSortMpegtsConns) can react.
        // Previous behaviour was to swallow the error and silently delete
        // the connection, leaving the decoder stuck on warning.
        registerMpegtsPair(router);

        // Sink module exists; source has no assigned UDP port → executeUdp throws.
        const mockModuleGetter = vi.fn().mockImplementation((id: string) => {
            if (id === 'decoder')
                return { config: {}, running: false, stop: vi.fn(), start: vi.fn() };
            return undefined;
        });
        router.setDependencies({} as any, mockModuleGetter);

        await expect(
            router.createConnection('encoder', 'mpegts-out', 'decoder', 'mpegts-in'),
        ).rejects.toThrow(/has not assigned a UDP port/);

        // Zombie connection must be removed — getConnections sees nothing.
        expect(router.getConnections()).toHaveLength(0);
    });

    // --- assignUdpPort / getUdpEndpoint ---

    it('assignUdpPort allocates a port with multicast address', () => {
        const result = router.assignUdpPort('enc-1');
        expect(result).not.toBeNull();
        expect(result!.host).toBe('239.255.0.1');
        expect(typeof result!.port).toBe('number');
    });

    it('assignUdpPort returns same port for same module', () => {
        const first = router.assignUdpPort('enc-1');
        const second = router.assignUdpPort('enc-1');
        expect(first).toEqual(second);
    });

    it('getUdpEndpoint returns undefined for unallocated module', () => {
        expect(router.getUdpEndpoint('unknown')).toBeUndefined();
    });

    it('getUdpEndpoint returns endpoint after assignment', () => {
        router.assignUdpPort('enc-1');
        const endpoint = router.getUdpEndpoint('enc-1');
        expect(endpoint).toBeDefined();
        expect(endpoint!.host).toBe('239.255.0.1');
    });

    it('releaseUdpPort frees the port', () => {
        router.assignUdpPort('enc-1');
        router.releaseUdpPort('enc-1');
        expect(router.getUdpEndpoint('enc-1')).toBeUndefined();
    });

    // --- per-port UDP allocation (multi-output mpeg-ts plugins) ---

    it('assignUdpPort with portId allocates a separate slot per output port', () => {
        const a = router.assignUdpPort('demux-1', 'out-0');
        const b = router.assignUdpPort('demux-1', 'out-1');
        const primary = router.assignUdpPort('demux-1');
        expect(a).not.toEqual(b);
        expect(a).not.toEqual(primary);
        expect(b).not.toEqual(primary);
    });

    it('getUdpEndpoint resolves per-port slot independently from the bare module key', () => {
        router.assignUdpPort('demux-1', 'out-0');
        expect(router.getUdpEndpoint('demux-1')).toBeUndefined();
        expect(router.getUdpEndpoint('demux-1', 'out-0')).toBeDefined();
    });

    it('releaseAllUdpPortsFor sweeps the bare slot and every per-port sub-slot', () => {
        router.assignUdpPort('demux-1');
        router.assignUdpPort('demux-1', 'out-0');
        router.assignUdpPort('demux-1', 'out-1');
        router.assignUdpPort('other-mod');
        router.releaseAllUdpPortsFor('demux-1');
        expect(router.getUdpEndpoint('demux-1')).toBeUndefined();
        expect(router.getUdpEndpoint('demux-1', 'out-0')).toBeUndefined();
        expect(router.getUdpEndpoint('demux-1', 'out-1')).toBeUndefined();
        // unrelated modules untouched
        expect(router.getUdpEndpoint('other-mod')).toBeDefined();
    });

    it('getModuleUdpSource prefers the per-port slot when the source has one allocated', async () => {
        // Source advertises two muxed/mpegts outputs; sink has one input.
        router.registerPorts('demux-1', [
            { id: 'out-0', direction: 'output', streamType: 'muxed/mpegts', label: 'A' },
            { id: 'out-1', direction: 'output', streamType: 'muxed/mpegts', label: 'B' },
        ]);
        router.registerPorts('player-1', [
            { id: 'mpegts-in', direction: 'input', streamType: 'muxed/mpegts', label: 'In' },
        ]);
        router.assignUdpPort('demux-1', 'out-0');
        router.assignUdpPort('demux-1', 'out-1');
        await router.createConnection('demux-1', 'out-1', 'player-1', 'mpegts-in');
        const src = router.getModuleUdpSource('player-1');
        expect(src).toBeDefined();
        expect(src!.sourcePortId).toBe('out-1');
        expect(src!.port).toBe(router.getUdpEndpoint('demux-1', 'out-1')!.port);
    });

    it('getModuleUdpSource falls back to module-level allocation for legacy single-port encoders', async () => {
        registerMpegtsPair(router);
        router.assignUdpPort('encoder');
        await router.createConnection('encoder', 'mpegts-out', 'decoder', 'mpegts-in');
        const src = router.getModuleUdpSource('decoder');
        expect(src).toBeDefined();
        expect(src!.port).toBe(router.getUdpEndpoint('encoder')!.port);
    });

    it('getModuleUdpSources returns one entry per connected muxed/mpegts source', async () => {
        // Two encoders feeding one muxer.
        router.registerPorts('enc-a', [
            { id: 'mpegts-out', direction: 'output', streamType: 'muxed/mpegts', label: 'A' },
        ]);
        router.registerPorts('enc-b', [
            { id: 'mpegts-out', direction: 'output', streamType: 'muxed/mpegts', label: 'B' },
        ]);
        router.registerPorts('mux-1', [
            { id: 'in-0', direction: 'input', streamType: 'muxed/mpegts', label: 'In0' },
            { id: 'in-1', direction: 'input', streamType: 'muxed/mpegts', label: 'In1' },
        ]);
        router.assignUdpPort('enc-a');
        router.assignUdpPort('enc-b');
        await router.createConnection('enc-a', 'mpegts-out', 'mux-1', 'in-0');
        await router.createConnection('enc-b', 'mpegts-out', 'mux-1', 'in-1');
        const sources = router.getModuleUdpSources('mux-1');
        expect(sources).toHaveLength(2);
        expect(sources.map((s) => s.sinkPortId).sort()).toEqual(['in-0', 'in-1']);
    });

    // --- getModuleConnections ---

    it('getModuleConnections returns only connections for the given module', async () => {
        registerAudioPair(router, 'a', 'b');
        router.registerPorts('c', [
            { id: 'out', direction: 'output', streamType: 'audio/pcm', label: 'Out' },
        ]);
        router.registerPorts('d', [
            { id: 'in', direction: 'input', streamType: 'audio/pcm', label: 'In' },
        ]);

        await router.createConnection('a', 'out', 'b', 'in');
        await router.createConnection('c', 'out', 'd', 'in');

        expect(router.getModuleConnections('a')).toHaveLength(1);
        expect(router.getModuleConnections('b')).toHaveLength(1);
        expect(router.getModuleConnections('c')).toHaveLength(1);
        expect(router.getModuleConnections('unknown')).toHaveLength(0);
    });

    // --- idempotent createConnection ---

    it('createConnection is idempotent — duplicate returns same ID', async () => {
        registerAudioPair(router);
        const id1 = await router.createConnection('a', 'out', 'b', 'in');
        const id2 = await router.createConnection('a', 'out', 'b', 'in');
        expect(id1).toBe(id2);
        expect(router.getConnections()).toHaveLength(1);
    });

    it('createConnection is idempotent on a single-slot port (mpegts-in, cap 1)', async () => {
        // Regression guard: re-applying an existing edge into a maxConnections:1
        // port must short-circuit on the idempotency check, NOT trip the capacity
        // guard. The double-apply happens in production because connections are
        // registered live (manager patch) and then again by ConnectionApplier at
        // startup. The capacity check used to run first, so the second apply threw
        // "Port mpegts-in already has 1/1 connections" instead of skipping.
        router.registerPorts('srt-input', [
            { id: 'mpegts-out', direction: 'output', streamType: 'muxed/mpegts', label: 'Out' },
        ]);
        router.registerPorts('audio-decoder', [
            {
                id: 'mpegts-in',
                direction: 'input',
                streamType: 'muxed/mpegts',
                label: 'In',
                maxConnections: 1,
            },
        ]);

        const id1 = await router.createConnection(
            'srt-input',
            'mpegts-out',
            'audio-decoder',
            'mpegts-in',
        );
        // Second identical apply must not throw and must return the same ID.
        const id2 = await router.createConnection(
            'srt-input',
            'mpegts-out',
            'audio-decoder',
            'mpegts-in',
        );
        expect(id2).toBe(id1);
        expect(router.getConnections()).toHaveLength(1);
    });

    it('createConnection still enforces capacity for a DIFFERENT source on a cap-1 port', async () => {
        // The idempotency fix must not weaken the capacity guard: a genuinely
        // different source targeting an already-full single-slot port must
        // still be rejected.
        router.registerPorts('srt-input-a', [
            { id: 'mpegts-out', direction: 'output', streamType: 'muxed/mpegts', label: 'Out' },
        ]);
        router.registerPorts('srt-input-b', [
            { id: 'mpegts-out', direction: 'output', streamType: 'muxed/mpegts', label: 'Out' },
        ]);
        router.registerPorts('audio-decoder', [
            {
                id: 'mpegts-in',
                direction: 'input',
                streamType: 'muxed/mpegts',
                label: 'In',
                maxConnections: 1,
            },
        ]);

        await router.createConnection('srt-input-a', 'mpegts-out', 'audio-decoder', 'mpegts-in');
        await expect(
            router.createConnection('srt-input-b', 'mpegts-out', 'audio-decoder', 'mpegts-in'),
        ).rejects.toThrow('already has 1/1 connections');
        expect(router.getConnections()).toHaveLength(1);
    });

    // --- invalidateOutgoingPwLinks (consumer-restart cascade) ---

    it('invalidateOutgoingPwLinks drops the source pw-link so it re-executes, but leaves mpegts/udp edges', async () => {
        // Regression guard for the mid-chain restart cascade: when a consumer
        // (decoder) is stopped/started to pick up a producer's udpsrc it
        // recreates its null-sink, orphaning its downstream pw-link. The stale
        // handle must be dropped so a re-apply re-links against the new node —
        // otherwise createConnection's "already exists" skip leaves the encoder
        // silent. muxed/mpegts edges survive a source restart and must NOT be
        // torn down (that would needlessly bounce the sink).
        const pipeWire = {
            pwUnlinkAllBetween: vi.fn().mockResolvedValue(undefined),
            listPorts: vi.fn().mockResolvedValue(['node:port_FL']),
            pwLink: vi.fn().mockResolvedValue(1),
            pwUnlinkByName: vi.fn().mockResolvedValue(undefined),
            pwUnlink: vi.fn().mockResolvedValue(undefined),
        };
        const moduleGetter = vi.fn().mockImplementation((id: string) => {
            if (id === 'dec')
                return {
                    running: true,
                    getPipeWireNodeForPort: () => undefined,
                    getPipeWireNodes: () => ({ source: 'dec.monitor' }),
                };
            if (id === 'enc')
                return {
                    running: true,
                    getPipeWireNodeForPort: () => undefined,
                    getPipeWireNodes: () => ({ sink: 'enc' }),
                };
            if (id === 'srt')
                return {
                    running: false,
                    stop: vi.fn().mockResolvedValue(undefined),
                    start: vi.fn().mockResolvedValue(undefined),
                };
            return undefined;
        });
        router.setDependencies(pipeWire as any, moduleGetter as any);

        router.registerPorts('dec', [
            { id: 'audio-out', direction: 'output', streamType: 'audio/pcm', label: 'Out' },
        ]);
        router.registerPorts('enc', [
            { id: 'audio-in', direction: 'input', streamType: 'audio/pcm', label: 'In' },
            { id: 'mpegts-out', direction: 'output', streamType: 'muxed/mpegts', label: 'TsOut' },
        ]);
        router.registerPorts('srt', [
            { id: 'mpegts-in', direction: 'input', streamType: 'muxed/mpegts', label: 'TsIn' },
        ]);

        router.assignUdpPort('enc');
        await router.createConnection('dec', 'audio-out', 'enc', 'audio-in'); // pw-link handle
        await router.createConnection('enc', 'mpegts-out', 'srt', 'mpegts-in'); // udp handle
        expect(router.getConnections()).toHaveLength(2);

        // Decoder restarted mid-chain → its outgoing pw-link handle is stale.
        await router.invalidateOutgoingPwLinks('dec');

        // pw-link edge removed (record gone → next re-apply re-executes it),
        // and its handle was torn down (pwUnlinkByName only runs in teardown).
        expect(router.getConnections().map((c) => c.id)).toEqual([
            'enc:mpegts-out-srt:mpegts-in',
        ]);
        expect(pipeWire.pwUnlinkByName).toHaveBeenCalled();

        // The mpegts/udp edge sourced by 'enc' is left intact — udp handles
        // survive a source restart, so re-executing them would just bounce the
        // sink for nothing.
        await router.invalidateOutgoingPwLinks('enc');
        expect(router.getConnections()).toHaveLength(1);
    });

    it('createConnection throws (not silently drops) when pw-link ports never appear — so the cascade re-link retries', async () => {
        // Regression guard paired with invalidateOutgoingPwLinks: after the
        // record is dropped, the re-apply must be retryable. A recreated
        // null-sink can miss the first waitForPorts poll (the cascade path has
        // no settle delay), so executePwLink throws rather than returning null
        // — otherwise createConnection drops the record and connectWithRetry
        // logs a false "Connected", leaving the edge gone until manual restart.
        const pipeWire = {
            pwUnlinkAllBetween: vi.fn().mockResolvedValue(undefined),
            listPorts: vi.fn().mockResolvedValue([]), // ports never appear
            pwLink: vi.fn().mockResolvedValue(1),
            pwUnlinkByName: vi.fn().mockResolvedValue(undefined),
            pwUnlink: vi.fn().mockResolvedValue(undefined),
        };
        const moduleGetter = vi.fn().mockImplementation((id: string) => {
            if (id === 'dec')
                return {
                    running: true,
                    getPipeWireNodeForPort: () => undefined,
                    getPipeWireNodes: () => ({ source: 'dec.monitor' }),
                };
            if (id === 'enc')
                return {
                    running: true,
                    getPipeWireNodeForPort: () => undefined,
                    getPipeWireNodes: () => ({ sink: 'enc' }),
                };
            return undefined;
        });
        router.setDependencies(pipeWire as any, moduleGetter as any);
        router.registerPorts('dec', [
            { id: 'audio-out', direction: 'output', streamType: 'audio/pcm', label: 'Out' },
        ]);
        router.registerPorts('enc', [
            { id: 'audio-in', direction: 'input', streamType: 'audio/pcm', label: 'In' },
        ]);

        await expect(
            router.createConnection('dec', 'audio-out', 'enc', 'audio-in'),
        ).rejects.toThrow(/ports/i);
        // Zombie record removed so a retry starts from a clean slate.
        expect(router.getConnections()).toHaveLength(0);
    }, 10_000);
});
