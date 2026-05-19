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
});
