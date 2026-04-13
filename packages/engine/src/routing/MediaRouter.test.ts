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

        const connId = await router.createConnection('encoder', 'mpegts-out', 'srt-output', 'mpegts-in');
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

        await expect(router.createConnection('audio', 'out', 'srt', 'in')).rejects.toThrow('Stream type mismatch');
    });

    it('rejects wrong port direction', async () => {
        router.registerPorts('mod-a', [
            { id: 'in', direction: 'input', streamType: 'audio/pcm', label: 'In' },
        ]);
        router.registerPorts('mod-b', [
            { id: 'in', direction: 'input', streamType: 'audio/pcm', label: 'In' },
        ]);

        await expect(router.createConnection('mod-a', 'in', 'mod-b', 'in')).rejects.toThrow('not an output');
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
            id: 'out', direction: 'output', streamType: 'audio/pcm',
            channelConfig: { channels: 2 }, label: 'Stereo Out',
        };
        const sink: ModulePort = {
            id: 'in', direction: 'input', streamType: 'audio/pcm',
            channelConfig: { channels: 6 }, label: '5.1 In',
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
        const connId = await router.createConnection('encoder', 'mpegts-out', 'decoder', 'mpegts-in');

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
            if (id === 'decoder') return { config: {}, running: false, stop: vi.fn(), start: vi.fn() };
            return undefined;
        });
        router.setDependencies({} as any, mockModuleGetter);

        // Assign an encoder port
        const endpoint = router.assignEncoderPort('encoder');
        expect(endpoint).not.toBeNull();

        // Create the MPEG-TS connection
        await router.createConnection('encoder', 'mpegts-out', 'decoder', 'mpegts-in');

        const source = router.getModuleUdpSource('decoder');
        expect(source).toBeDefined();
        expect(source!.host).toBe('239.255.0.1');
        expect(source!.port).toBe(endpoint!.port);
        expect(source!.codec).toBe('opus');
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

    // --- assignEncoderPort / getEncoderEndpoint ---

    it('assignEncoderPort allocates a port with multicast address', () => {
        const result = router.assignEncoderPort('enc-1');
        expect(result).not.toBeNull();
        expect(result!.host).toBe('239.255.0.1');
        expect(typeof result!.port).toBe('number');
    });

    it('assignEncoderPort returns same port for same module', () => {
        const first = router.assignEncoderPort('enc-1');
        const second = router.assignEncoderPort('enc-1');
        expect(first).toEqual(second);
    });

    it('getEncoderEndpoint returns undefined for unallocated module', () => {
        expect(router.getEncoderEndpoint('unknown')).toBeUndefined();
    });

    it('getEncoderEndpoint returns endpoint after assignment', () => {
        router.assignEncoderPort('enc-1');
        const endpoint = router.getEncoderEndpoint('enc-1');
        expect(endpoint).toBeDefined();
        expect(endpoint!.host).toBe('239.255.0.1');
    });

    it('releaseEncoderPort frees the port', () => {
        router.assignEncoderPort('enc-1');
        router.releaseEncoderPort('enc-1');
        expect(router.getEncoderEndpoint('enc-1')).toBeUndefined();
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
