import { describe, it, expect } from 'vitest';
import type {
    StreamType,
    ModulePort,
    ModuleRuntimeState,
    DgramMessage,
    ManagerConnectionProfile,
    MpegTsStreamInfo,
    ControlIpcMessage,
    PluginManifest,
} from './index';

describe('shared-types', () => {
    it('StreamType accepts valid values', () => {
        const types: StreamType[] = ['audio/pcm', 'muxed/mpegts', 'video/raw'];
        expect(types).toHaveLength(3);
    });

    it('ModulePort shape is correct', () => {
        const port: ModulePort = {
            id: 'audio-out',
            direction: 'output',
            streamType: 'audio/pcm',
            label: 'Audio Out',
        };
        expect(port.id).toBe('audio-out');
        expect(port.direction).toBe('output');
    });

    it('ModuleRuntimeState shape is correct', () => {
        const state: ModuleRuntimeState = {
            running: true,
            ready: true,
            health: 'ok',
            pendingRestart: false,
        };
        expect(state.running).toBe(true);
        expect(state.health).toBe('ok');
    });

    it('DgramMessage shape is correct', () => {
        const msg: DgramMessage = {
            type: 'data',
            clientID: 'engine-1',
            data: { topic: 'state', message: { running: true } },
        };
        expect(msg.type).toBe('data');
        expect(msg.data.topic).toBe('state');
    });

    it('PluginManifest shape is correct', () => {
        const manifest: PluginManifest = {
            pluginId: 'example',
            displayName: 'Example',
            description: 'An example plugin',
            category: 'utility',
            architectures: ['arm64', 'x86_64'],
            ports: [],
            configSchema: {},
            engine: './engine/ExampleModule.ts',
        };
        expect(manifest.pluginId).toBe('example');
    });
});
