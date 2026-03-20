import { describe, it, expect, beforeEach } from 'vitest';
import { MediaRouter } from './MediaRouter.js';
import type { ModulePort } from '@media-router/shared-types';

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
});
