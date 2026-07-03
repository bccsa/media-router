import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { readCpuTemp, readCoretempAverage } from './SystemStatsCollector.js';

describe('readCoretempAverage', () => {
    const root = path.join(__dirname, '__test-hwmon__');

    /** Write a hwmon device with the given name and temp sensors [label, milliC]. */
    function hwmon(index: number, name: string, sensors: Array<[string, string, number]> = []): void {
        const dir = path.join(root, `hwmon${index}`);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'name'), `${name}\n`);
        for (const [tempId, label, milliC] of sensors) {
            fs.writeFileSync(path.join(dir, `${tempId}_label`), `${label}\n`);
            fs.writeFileSync(path.join(dir, `${tempId}_input`), `${milliC}\n`);
        }
    }

    beforeEach(() => fs.mkdirSync(root, { recursive: true }));
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    it('averages the per-core sensors and ignores "Package id 0"', () => {
        // Mirrors coretemp on the x86 box 10.9.1.160
        hwmon(2, 'coretemp', [
            ['temp1', 'Package id 0', 72000], // hottest-core peak — must be excluded
            ['temp2', 'Core 0', 60000],
            ['temp6', 'Core 4', 68000],
            ['temp10', 'Core 8', 64000],
        ]);
        expect(readCoretempAverage(root)).toBe(64); // (60+68+64)/3
    });

    it('ignores non-coretemp hwmon devices', () => {
        hwmon(0, 'acpitz', [['temp1', '', 27800]]);
        hwmon(1, 'iwlwifi_1', [['temp1', '', 37000]]);
        hwmon(2, 'coretemp', [
            ['temp2', 'Core 0', 50000],
            ['temp3', 'Core 1', 54000],
        ]);
        expect(readCoretempAverage(root)).toBe(52);
    });

    it('returns null when there is no coretemp device (e.g. the Pi)', () => {
        hwmon(0, 'cpu_thermal', [['temp1', '', 48000]]);
        expect(readCoretempAverage(root)).toBeNull();
    });

    it('returns null when coretemp exposes only the package sensor', () => {
        hwmon(2, 'coretemp', [['temp1', 'Package id 0', 70000]]);
        expect(readCoretempAverage(root)).toBeNull();
    });

    it('discards implausible core readings from the average', () => {
        hwmon(2, 'coretemp', [
            ['temp2', 'Core 0', -273300], // phantom / bogus
            ['temp3', 'Core 1', 60000],
            ['temp4', 'Core 2', 62000],
        ]);
        expect(readCoretempAverage(root)).toBe(61); // (60+62)/2
    });

    it('returns null when the hwmon subsystem is absent', () => {
        expect(readCoretempAverage(path.join(root, 'nope'))).toBeNull();
    });
});

describe('readCpuTemp', () => {
    const root = path.join(__dirname, '__test-thermal__');
    const noHwmon = path.join(root, 'no-hwmon'); // forces the thermal-zone fallback

    function zone(index: number, type: string, milliC: number): void {
        const dir = path.join(root, `thermal_zone${index}`);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'type'), `${type}\n`);
        fs.writeFileSync(path.join(dir, 'temp'), `${milliC}\n`);
    }

    function coretemp(sensors: Array<[string, string, number]>): void {
        const dir = path.join(root, 'hwmon', 'hwmon0');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'name'), 'coretemp\n');
        for (const [tempId, label, milliC] of sensors) {
            fs.writeFileSync(path.join(dir, `${tempId}_label`), `${label}\n`);
            fs.writeFileSync(path.join(dir, `${tempId}_input`), `${milliC}\n`);
        }
    }

    beforeEach(() => fs.mkdirSync(root, { recursive: true }));
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    it('prefers the coretemp core average over the thermal-zone package sensor', () => {
        zone(3, 'x86_pkg_temp', 90000); // hot package peak
        coretemp([
            ['temp2', 'Core 0', 60000],
            ['temp3', 'Core 1', 64000],
        ]);
        expect(readCpuTemp(root, path.join(root, 'hwmon'))).toBe(62); // core avg, not 90
    });

    it('ignores the phantom acpitz zone and picks the real CPU sensor (no coretemp)', () => {
        // Mirrors the x86 box 10.9.1.160 where thermal_zone0 = acpitz = -273300
        zone(0, 'acpitz', -273300);
        zone(1, 'acpitz', 27800);
        zone(2, 'iwlwifi_1', 37000);
        zone(3, 'x86_pkg_temp', 53000);
        expect(readCpuTemp(root, noHwmon)).toBe(53);
    });

    it('reads a Raspberry Pi cpu-thermal zone at thermal_zone0', () => {
        zone(0, 'cpu-thermal', 48250);
        expect(readCpuTemp(root, noHwmon)).toBe(48);
    });

    it('falls back to the hottest valid zone when no preferred type matches', () => {
        zone(0, 'acpitz', -273300);
        zone(1, 'mystery', 41000);
        zone(2, 'other', 45600);
        expect(readCpuTemp(root, noHwmon)).toBe(46);
    });

    it('never returns an absolute-zero reading', () => {
        zone(0, 'acpitz', -273300);
        zone(1, 'acpitz', -273300);
        expect(readCpuTemp(root, noHwmon)).toBeNull();
    });

    it('rejects implausibly high readings', () => {
        zone(0, 'x86_pkg_temp', 200000); // 200°C — bogus
        zone(1, 'cpu-thermal', 55000);
        expect(readCpuTemp(root, noHwmon)).toBe(55);
    });

    it('returns null when neither coretemp nor thermal zones are available', () => {
        expect(readCpuTemp(path.join(root, 'does-not-exist'), noHwmon)).toBeNull();
    });
});
