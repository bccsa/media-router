import * as os from 'os';
import * as fs from 'fs';
import { createLogger } from '@media-router/shared-types';
import { getAllIps, findBuildNumber, getHostname } from './deviceInfo.js';

const log = createLogger('SystemStats');

export interface SystemStats {
    cpu: number;
    mem: number;
    temp: number | null;
    /**
     * Raspberry Pi under-voltage warning. Only ever `true` (and only once the
     * collector has latched — see below); omitted otherwise, so non-Pi hosts and
     * healthy boxes send nothing.
     */
    undervoltage?: boolean;
    processCount?: number;
    ip?: string;
    ips?: string[];
    hostname?: string;
    buildNumber?: string;
}

// Thermal-zone `type` values that correspond to a real CPU/SoC sensor,
// in order of preference. On the Pi target thermal_zone0 is `cpu-thermal`;
// on x86 hosts thermal_zone0 is often a phantom `acpitz` zone that reports
// ~-273°C (0 Kelvin), so we must not blindly read thermal_zone0.
const PREFERRED_ZONE_TYPES = [
    'cpu-thermal',
    'cpu_thermal',
    'x86_pkg_temp',
    'soc',
    'soc_thermal',
    'coretemp',
];

const isCoreLabel = (label: string): boolean => /^core\b/i.test(label);

/**
 * Average the per-core temperatures from the `coretemp` hwmon (x86/Intel).
 * Averages every sensor labelled "Core N" and ignores "Package id 0" (which
 * is the hottest-core peak, not a core) — the average is far steadier and more
 * representative than the package sensor, which sawtooths tens of degrees under
 * bursty load. Returns null when there is no coretemp device with core sensors
 * (e.g. the Raspberry Pi, which exposes a single SoC zone instead).
 */
export function readCoretempAverage(hwmonRoot = '/sys/class/hwmon'): number | null {
    let devices: string[];
    try {
        devices = fs.readdirSync(hwmonRoot);
    } catch {
        return null;
    }

    const coreTemps: number[] = [];
    for (const dev of devices) {
        const base = `${hwmonRoot}/${dev}`;
        try {
            if (fs.readFileSync(`${base}/name`, 'utf-8').trim() !== 'coretemp') continue;
        } catch {
            continue;
        }
        let entries: string[];
        try {
            entries = fs.readdirSync(base);
        } catch {
            continue;
        }
        for (const entry of entries) {
            const m = entry.match(/^(temp\d+)_input$/);
            if (!m) continue;
            let label = '';
            try {
                label = fs.readFileSync(`${base}/${m[1]}_label`, 'utf-8').trim();
            } catch {
                /* label optional */
            }
            if (!isCoreLabel(label)) continue; // per-core sensors only, skip "Package id"
            let celsius: number;
            try {
                celsius = parseInt(fs.readFileSync(`${base}/${entry}`, 'utf-8'), 10) / 1000;
            } catch {
                continue;
            }
            if (!Number.isFinite(celsius) || celsius <= -40 || celsius >= 150) continue;
            coreTemps.push(celsius);
        }
    }

    if (coreTemps.length === 0) return null;
    return Math.round(coreTemps.reduce((a, b) => a + b, 0) / coreTemps.length);
}

/**
 * Read the CPU temperature (°C).
 * Prefers the average across all CPU cores (coretemp on x86) — steadier and
 * more representative than the hottest-core package sensor. Falls back to the
 * kernel thermal zones (e.g. the Pi's single `cpu-thermal`), discarding
 * physically implausible readings (phantom ACPI zones report ~-273°C / 0 K)
 * and preferring a known CPU sensor type. Returns null when nothing usable.
 */
export function readCpuTemp(
    thermalRoot = '/sys/class/thermal',
    hwmonRoot = '/sys/class/hwmon',
): number | null {
    const coreAvg = readCoretempAverage(hwmonRoot);
    if (coreAvg !== null) return coreAvg;

    let zones: string[];
    try {
        zones = fs.readdirSync(thermalRoot).filter((d) => d.startsWith('thermal_zone'));
    } catch {
        return null; // no thermal subsystem on this hardware
    }

    const readings: Array<{ type: string; celsius: number }> = [];
    for (const zone of zones) {
        let celsius: number;
        try {
            celsius = parseInt(fs.readFileSync(`${thermalRoot}/${zone}/temp`, 'utf-8'), 10) / 1000;
        } catch {
            continue; // zone unreadable
        }
        // Reject impossible readings: phantom zones report ~-273°C (0 K).
        if (!Number.isFinite(celsius) || celsius <= -40 || celsius >= 150) continue;

        let type = '';
        try {
            type = fs.readFileSync(`${thermalRoot}/${zone}/type`, 'utf-8').trim();
        } catch {
            /* type is optional */
        }
        readings.push({ type, celsius });
    }

    if (readings.length === 0) return null;

    for (const preferred of PREFERRED_ZONE_TYPES) {
        const match = readings.find((r) => r.type === preferred);
        if (match) return Math.round(match.celsius);
    }
    return Math.round(Math.max(...readings.map((r) => r.celsius)));
}

/**
 * Read the Raspberry Pi under-voltage flag.
 *
 * The `raspberrypi_hwmon` firmware driver exposes a hwmon device named
 * `rpi_volt` with a single attribute `in0_lcrit_alarm`: `1` = the 5 V rail has
 * sagged below the critical threshold (the firmware is throttling the ARM
 * clock), `0` = OK. This is the same signal Raspberry Pi OS surfaces as its
 * on-screen lightning-bolt icon. It is world-readable, so the engine reads it
 * unprivileged.
 *
 * Returns:
 *   - `true`  — under-voltage right now
 *   - `false` — sensor present, rail OK
 *   - `null`  — no `rpi_volt` device (non-Pi hardware) or hwmon unreadable;
 *               "can't determine", deliberately distinct from `false` so callers
 *               never raise a false alarm on x86 dev hosts.
 *
 * Note: this Yocto image ships no `vcgencmd`, so `in0_lcrit_alarm` is the only
 * interface and it reports only the *live* state (no voltage value, no firmware
 * sticky-bit history) — persistence is the caller's job (see the collector's
 * debounce-and-latch below).
 */
export function readUndervoltage(hwmonRoot = '/sys/class/hwmon'): boolean | null {
    let devices: string[];
    try {
        devices = fs.readdirSync(hwmonRoot);
    } catch {
        return null; // no hwmon subsystem
    }
    for (const dev of devices) {
        const base = `${hwmonRoot}/${dev}`;
        try {
            if (fs.readFileSync(`${base}/name`, 'utf-8').trim() !== 'rpi_volt') continue;
        } catch {
            continue;
        }
        try {
            return parseInt(fs.readFileSync(`${base}/in0_lcrit_alarm`, 'utf-8'), 10) === 1;
        } catch {
            return null; // device present but attribute unreadable
        }
    }
    return null; // no rpi_volt device — not a Pi
}

/**
 * Periodically collects CPU, memory, and temperature stats.
 * Calls the provided callback with each sample.
 */
export class SystemStatsCollector {
    private timer: ReturnType<typeof setInterval> | null = null;
    private prevCpuTotal = 0;
    private prevCpuIdle = 0;
    private sampleCount = 0;
    private cachedBuildNumber: string | null = null;
    // Under-voltage debounce + latch. `streak` counts consecutive under-voltage
    // samples; the latch arms after 2 (~2-4s) so a lone boot-inrush blip doesn't
    // permanently flag a healthy box, and stays armed until this process
    // restarts (a genuine power fault sags repeatedly, so it re-arms in seconds
    // after a restart if still faulty).
    private undervoltageStreak = 0;
    private undervoltageLatched = false;

    constructor(
        private onStats: (stats: SystemStats) => void,
        private intervalMs = 2000,
    ) {}

    /**
     * Debounce-then-latch step for the under-voltage flag. Feeds one reading
     * (`true`/`false`/`null`) through the streak counter and the sticky latch,
     * logs once when it arms, and returns whether the emitted stats should carry
     * `undervoltage: true`. A `null` reading (no sensor) resets the streak like
     * an OK read, so non-Pi hosts never latch. Extracted from the tick so the
     * 2-consecutive boundary is unit-testable without driving the interval.
     */
    private updateUndervoltage(reading: boolean | null): boolean {
        if (reading === true) this.undervoltageStreak++;
        else this.undervoltageStreak = 0;
        if (this.undervoltageStreak >= 2 && !this.undervoltageLatched) {
            this.undervoltageLatched = true;
            log.warn('Under-voltage detected — CPU is being throttled; check PSU/USB-C cable');
        }
        return this.undervoltageLatched;
    }

    start(): void {
        if (this.timer) return;
        this.timer = setInterval(() => {
            try {
                const cpus = os.cpus();
                let totalTick = 0;
                let idleTick = 0;
                for (const cpu of cpus) {
                    for (const type of Object.values(cpu.times) as number[]) totalTick += type;
                    idleTick += cpu.times.idle;
                }
                const totalDelta = totalTick - this.prevCpuTotal;
                const idleDelta = idleTick - this.prevCpuIdle;
                const cpuPercent =
                    totalDelta > 0 ? Math.round((1 - idleDelta / totalDelta) * 100) : 0;
                this.prevCpuTotal = totalTick;
                this.prevCpuIdle = idleTick;

                const totalMem = os.totalmem();
                const freeMem = os.freemem();
                const memPercent = Math.round(((totalMem - freeMem) / totalMem) * 100);

                const stats: SystemStats = {
                    cpu: cpuPercent,
                    mem: memPercent,
                    temp: readCpuTemp(),
                };

                if (this.updateUndervoltage(readUndervoltage())) stats.undervoltage = true;

                // Include IP + hostname + build on first sample and every 30 samples (~60s)
                if (this.sampleCount % 30 === 0) {
                    const ips = getAllIps();
                    stats.ip = ips[0] ?? '127.0.0.1';
                    stats.ips = ips;
                    stats.hostname = getHostname();
                    if (this.cachedBuildNumber === null) {
                        this.cachedBuildNumber = findBuildNumber();
                    }
                    if (this.cachedBuildNumber) stats.buildNumber = this.cachedBuildNumber;
                }
                this.sampleCount++;

                this.onStats(stats);
            } catch (err) {
                log.debug({ err }, 'Stats collection tick failed');
            }
        }, this.intervalMs);
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
}
