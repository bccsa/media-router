import { describe, it, expect } from 'vitest';
import type { ModuleState } from '@/stores/engines';
import { buildModuleMenuItems } from './moduleMenuItems';

/** A module whose `level` is in the right-click menu, its maximum declared by `level`. */
function moduleWith(
    level: Record<string, unknown>,
    settings: Record<string, unknown>,
): ModuleState {
    return {
        instanceId: 'm1',
        pluginId: 'audio-encoder',
        displayName: 'Encoder',
        settings,
        configSchema: {
            properties: {
                codec: { type: 'string', enum: ['opus', 'aac'] },
                volumeMax: { type: 'number', enum: [100, 150, 500] },
                level: { type: 'number', 'x-widget': 'slider', 'x-contextMenu': true, ...level },
            },
        },
    } as unknown as ModuleState;
}

const sliderMax = (mod: ModuleState) =>
    buildModuleMenuItems(mod, false).find((i) => i.action === 'setting:level')?.slider?.max;

describe("the module menu's slider maximum is the manager's rule (B-103)", () => {
    const ranged = { minimum: 0, maximum: 150, 'x-maxFrom': 'volumeMax' };

    it("x-maxFrom: Volume Range's number, else the static maximum", () => {
        expect(sliderMax(moduleWith(ranged, { volumeMax: 500, level: 300 }))).toBe(500);
        expect(sliderMax(moduleWith(ranged, { level: 100 }))).toBe(150);
        // Not a number: the manager's write check bounds it at 150, so the menu does too.
        expect(sliderMax(moduleWith(ranged, { volumeMax: '500', level: 100 }))).toBe(150);
    });

    it("x-maxBy: the controlling setting's entry", () => {
        const byCodec = {
            minimum: 6,
            maximum: 510,
            'x-maxBy': { field: 'codec', map: { opus: 510, aac: 320 } },
        };
        expect(sliderMax(moduleWith(byCodec, { codec: 'aac' }))).toBe(320);
        expect(sliderMax(moduleWith(byCodec, { codec: 'opus' }))).toBe(510);
    });

    it("a field with no maximum at all gets the menu's 0-100 slider", () => {
        expect(sliderMax(moduleWith({}, {}))).toBe(100);
    });
});
