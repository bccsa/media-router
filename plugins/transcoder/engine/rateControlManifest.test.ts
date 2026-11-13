import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { QVBR_QUALITY_DEFAULT, RATE_CONTROLS } from '@media-router/engine';

/** The manifest's rate-control enums and quality range are copies of the
 *  engine's; this pins them so a new mode can't land in one and not the other. */
const props = JSON.parse(
    readFileSync(join(process.cwd(), 'plugins', 'transcoder', 'package.json'), 'utf8'),
).mediaRouter.configSchema.properties;
const item = props.renditions.items.properties;

describe('transcoder manifest rate control', () => {
    it('global and per-rendition rateControl enums are RATE_CONTROLS, each labelled', () => {
        for (const rc of [props.rateControl, item.rateControl]) {
            expect(rc.enum).toEqual(RATE_CONTROLS);
            expect(Object.keys(rc['x-enumLabels'])).toEqual(RATE_CONTROLS);
        }
    });

    it('quality is 1–51 with the engine default; the override shows only under qvbr', () => {
        expect(props.quality).toMatchObject({
            minimum: 1,
            maximum: 51,
            default: QVBR_QUALITY_DEFAULT,
        });
        expect(item.quality).toMatchObject({
            minimum: 1,
            maximum: 51,
            'x-showWhen': 'rateControl=qvbr',
        });
        expect(item.quality.default).toBeUndefined(); // blank = inherit
    });
});
