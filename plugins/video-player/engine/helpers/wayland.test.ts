import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { bootNowMs, processStartMs } from './wayland.js';

/**
 * `processStartMs` reads a real `/proc/<pid>/stat` line, so these stage a fake
 * proc root on disk rather than mocking `fs` — the parsing (find the last `)`,
 * count 19 fields on from there) is the whole point and a mock would test the
 * mock.
 */
describe('processStartMs', () => {
    let procRoot: string;

    /**
     * Fields 3..21 of a real stat line — state, ppid, pgrp, session, tty_nr,
     * tpgid, flags, {min,cmin,maj,cmaj}flt, {u,s,cu,cs}time, priority, nice,
     * num_threads, itrealvalue. The values are irrelevant; the COUNT is not,
     * because field 22 (the next one) is `starttime`.
     */
    const BETWEEN = 'R 1 1 1 0 -1 4194304 63 0 0 0 0 0 0 0 20 0 1 0';

    /** A /proc/<pid>/stat line with `comm` and `starttime` under our control. */
    function writeStat(pid: number, comm: string, starttimeTicks: number): void {
        fs.mkdirSync(path.join(procRoot, String(pid)), { recursive: true });
        fs.writeFileSync(
            path.join(procRoot, String(pid), 'stat'),
            `${pid} (${comm}) ${BETWEEN} ${starttimeTicks} 5619712 64\n`,
        );
    }

    beforeEach(() => {
        procRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-proc-'));
    });

    afterEach(() => {
        fs.rmSync(procRoot, { recursive: true, force: true });
    });

    it('converts USER_HZ ticks since boot to milliseconds', () => {
        // Guard the fixture itself: one field too few here would silently move
        // `starttime` and make every case below assert the wrong column.
        expect(BETWEEN.split(' ')).toHaveLength(19);
        writeStat(500, 'cog', 162_456_639);
        // 100 ticks = 1 s, so the value is boot-relative ms — comparable with
        // bootNowMs() and immune to the NTP step a Pi takes seconds into boot.
        expect(processStartMs(500, procRoot)).toBeCloseTo(1_624_566_390, 3);
    });

    it('survives spaces and parentheses inside comm', () => {
        // `comm` is the executable basename in parens and is NOT escaped, so
        // splitting the whole line on whitespace lands on the wrong field for
        // any process whose name contains a space or a paren. Slicing after
        // the LAST `)` is what makes field 22 findable at all.
        writeStat(501, 'we (b) ird proc', 300_000);
        expect(processStartMs(501, procRoot)).toBe(3_000_000);
    });

    it('returns undefined when the process is gone', () => {
        expect(processStartMs(999_999, procRoot)).toBeUndefined();
    });

    it('returns undefined for an unparseable stat line', () => {
        // Truncated line — no field 22. Must be undefined, not NaN: the caller
        // treats undefined as "wait" and would compare NaN as always-false.
        fs.mkdirSync(path.join(procRoot, '502'), { recursive: true });
        fs.writeFileSync(path.join(procRoot, '502', 'stat'), '502 (cog) R 1 1\n');
        expect(processStartMs(502, procRoot)).toBeUndefined();
    });
});

describe('bootNowMs', () => {
    it('reads /proc/uptime as a positive boot-relative millisecond count', () => {
        const now = bootNowMs();
        expect(now).toBeGreaterThan(0);
        // Same timeline as processStartMs: this process cannot have started
        // before the machine booted, and must not be in the future.
        const self = processStartMs(process.pid)!;
        expect(self).toBeGreaterThan(0);
        expect(self).toBeLessThanOrEqual(now);
    });
});
