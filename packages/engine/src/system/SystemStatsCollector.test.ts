import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { readCpuTemp, RollingMax } from './SystemStatsCollector.js';

describe('readCpuTemp', () => {
    const root = path.join(__dirname, '__test-thermal__');

    function zone(index: number, type: string, milliC: number): void {
        const dir = path.join(root, `thermal_zone${index}`);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'type'), `${type}\n`);
        fs.writeFileSync(path.join(dir, 'temp'), `${milliC}\n`);
    }

    beforeEach(() => {
        fs.mkdirSync(root, { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('ignores the phantom acpitz zone reporting ~-273°C and picks the real CPU sensor', () => {
        // Mirrors the x86 box 10.9.1.160 where thermal_zone0 = acpitz = -273300
        zone(0, 'acpitz', -273300);
        zone(1, 'acpitz', 27800);
        zone(2, 'iwlwifi_1', 37000);
        zone(3, 'x86_pkg_temp', 53000);
        expect(readCpuTemp(root)).toBe(53);
    });

    it('reads a Raspberry Pi cpu-thermal zone at thermal_zone0', () => {
        zone(0, 'cpu-thermal', 48250);
        expect(readCpuTemp(root)).toBe(48);
    });

    it('falls back to the hottest valid zone when no preferred type matches', () => {
        zone(0, 'acpitz', -273300);
        zone(1, 'mystery', 41000);
        zone(2, 'other', 45600);
        expect(readCpuTemp(root)).toBe(46);
    });

    it('never returns an absolute-zero reading', () => {
        zone(0, 'acpitz', -273300);
        zone(1, 'acpitz', -273300);
        expect(readCpuTemp(root)).toBeNull();
    });

    it('rejects implausibly high readings', () => {
        zone(0, 'x86_pkg_temp', 200000); // 200°C — bogus
        zone(1, 'cpu-thermal', 55000);
        expect(readCpuTemp(root)).toBe(55);
    });

    it('returns null when the thermal subsystem is absent', () => {
        expect(readCpuTemp(path.join(root, 'does-not-exist'))).toBeNull();
    });
});

describe('RollingMax', () => {
    it('reacts up instantly to a spike', () => {
        const rm = new RollingMax(5);
        expect(rm.add(60)).toBe(60);
        expect(rm.add(87)).toBe(87); // spike shows immediately
    });

    it('holds the peak until it ages out of the window', () => {
        const rm = new RollingMax(3);
        rm.add(90); // window: [90]
        expect(rm.add(65)).toBe(90); // [90,65]
        expect(rm.add(66)).toBe(90); // [90,65,66]
        expect(rm.add(67)).toBe(67); // 90 dropped -> [65,66,67]
    });

    it('tracks a new higher peak', () => {
        const rm = new RollingMax(3);
        rm.add(70);
        rm.add(80);
        expect(rm.add(95)).toBe(95);
    });

    it('smooths a sawtooth to its upper envelope, not a random point', () => {
        const rm = new RollingMax(5);
        let last = 0;
        for (const v of [65, 90, 66, 88, 67, 91, 65]) last = rm.add(v);
        expect(last).toBe(91); // reports the peak, not the trailing 65
    });

    it('a window of size 1 is just the raw value (no smoothing)', () => {
        const rm = new RollingMax(1);
        expect(rm.add(60)).toBe(60);
        expect(rm.add(87)).toBe(87);
        expect(rm.add(61)).toBe(61);
    });

    it('reset clears the retained peak', () => {
        const rm = new RollingMax(5);
        rm.add(90);
        rm.reset();
        expect(rm.add(60)).toBe(60);
    });
});
