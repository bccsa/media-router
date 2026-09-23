import { describe, it, expect } from 'vitest';
import { POSITIONED_302M_MASK, positionedChannelsClause } from './channelLayout.js';

describe('positionedChannelsClause', () => {
    it('renders an identity matrix and the default layout mask for every 302M width', () => {
        for (const n of [2, 4, 6, 8]) {
            const clause = positionedChannelsClause(n);
            expect(clause.startsWith('audioconvert mix-matrix="<')).toBe(true);
            expect(clause).toContain(
                `! audio/x-raw,channels=${n},channel-mask=(bitmask)${POSITIONED_302M_MASK[n]}`,
            );
            const rows = /mix-matrix="<(.*)>"/.exec(clause)![1].split('>, <');
            expect(rows).toHaveLength(n);
            rows.forEach((row, d) => {
                const cells = row.replace(/[<>]/g, '').split(', ');
                expect(cells).toHaveLength(n);
                cells.forEach((c, s) => expect(c).toBe(`(float)${s === d ? '1.0000' : '0.0000'}`));
            });
        }
    });

    it('pins the exact stereo shape audio-input-302m has always emitted', () => {
        expect(positionedChannelsClause(2)).toBe(
            'audioconvert mix-matrix="<<(float)1.0000, (float)0.0000>, <(float)0.0000, (float)1.0000>>"' +
                ' ! audio/x-raw,channels=2,channel-mask=(bitmask)0x3',
        );
    });
});
