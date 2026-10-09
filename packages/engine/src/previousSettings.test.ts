import { describe, it, expect } from 'vitest';
import type { PatchOp } from '@media-router/shared-types';
import { previousSettings } from './previousSettings.js';

const set = (path: string, value: unknown): PatchOp => ({ op: 'replace', path, value });

function config() {
    return {
        modules: {
            mux: { pluginId: 'mpegts-muxer', settings: { inputs: [{ name: 'A' }] } },
            mic: { pluginId: 'audio-input', settings: { volume: 100, gain: 0 } },
        },
        connections: [{ id: 'c1' }],
    };
}

describe('previousSettings', () => {
    it('records the value each settings write replaces, per module', () => {
        const c = config();
        const inputs = c.modules.mux.settings.inputs;
        const previous = previousSettings(
            [
                set('/modules/mux/settings/inputs', [{ name: 'A' }, { name: 'B' }]),
                set('/modules/mic/settings/volume', 80),
                set('/modules/mic/settings/gain', 6),
            ],
            c,
        );
        expect(previous.get('mux')!.inputs).toBe(inputs);
        expect(previous.get('mic')).toEqual({ volume: 100, gain: 0 });
    });

    it('records a key the patch adds as present but undefined', () => {
        const previous = previousSettings(
            [{ op: 'add', path: '/modules/mic/settings/mute', value: true }],
            config(),
        );
        expect(previous.get('mic')).toHaveProperty('mute', undefined);
    });

    it('ignores everything but the settings of a module the config has', () => {
        const previous = previousSettings(
            [
                set('/modules/mic/displayName', 'Mic'),
                set('/modules/mic/enabled', false),
                set('/modules/mic/settings', { volume: 1 }),
                set('/modules/ghost/settings/volume', 1),
                set('/connections/0/channelMap', []),
            ],
            config(),
        );
        expect(previous.size).toBe(0);
    });
});
