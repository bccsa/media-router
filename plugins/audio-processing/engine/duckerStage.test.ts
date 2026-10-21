import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stages } from './chainStages.fixture.js';
import {
    DUCKER_CHANNEL,
    DUCKER_ELEMENT,
    DUCKER_PROP_MAP,
    duckerElement,
    resolveDuckerWrites,
} from './duckerStage.js';

const schema = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).mediaRouter
    .configSchema.properties as Record<string, { minimum: number; maximum: number }>;

describe('duckerElement', () => {
    it('names the element and carries every duck setting, defaults applied', () => {
        expect(duckerElement({})).toBe(
            'mrducker name=ducker threshold=-35 depth=-12 attack=5 release=200 hold=250',
        );
        expect(duckerElement({ threshold: -40, duckDepth: -6, hold: 0 })).toBe(
            'mrducker name=ducker threshold=-40 depth=-6 attack=5 release=200 hold=0',
        );
    });

    it("clamps to each setting's schema range, which is the element's", () => {
        for (const [key, { prop, convert }] of Object.entries(DUCKER_PROP_MAP)) {
            const { minimum, maximum } = schema[key];
            expect(convert(minimum - 1000), `${key} -> ${prop} floor`).toBe(minimum);
            expect(convert(maximum + 1000), `${key} -> ${prop} ceiling`).toBe(maximum);
            expect(convert('junk'), `${key} junk`).toBe(minimum);
        }
    });
});

describe('resolveDuckerWrites', () => {
    const ducking = stages({ dynMode: 'ducker', duckerKey: true });

    it('one property write per duck setting, on the ducker', () => {
        expect(resolveDuckerWrites('release', 1, ducking)).toEqual([
            { element: DUCKER_ELEMENT, prop: 'release', value: 5 },
        ]);
        expect(resolveDuckerWrites('attack', 12.34567, ducking)).toEqual([
            { element: DUCKER_ELEMENT, prop: 'attack', value: 12.3457 },
        ]);
    });

    it('nothing without the ducker, and nothing for any other key', () => {
        expect(resolveDuckerWrites('threshold', -20, stages({ dynMode: 'ducker' }))).toEqual([]);
        expect(
            resolveDuckerWrites(
                'threshold',
                -20,
                stages({ dynMode: 'compressor', duckerKey: true }),
            ),
        ).toEqual([]);
        for (const key of ['ratio', 'toString', 'constructor', 'gateDepth']) {
            expect(resolveDuckerWrites(key, 1, ducking), key).toEqual([]);
        }
    });

    it('the plugin-event channel is the busReport: `<structure>:<element>`', () => {
        expect(DUCKER_CHANNEL).toBe('mrducker:ducker');
    });
});
