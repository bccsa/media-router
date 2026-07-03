import * as os from 'os';
import * as fs from 'fs';
import { createLogger } from '@media-router/shared-types';
import { getAllIps, findBuildNumber, getHostname } from './deviceInfo.js';

const log = createLogger('SystemStats');

export interface SystemStats {
    cpu: number;
    mem: number;
    temp: number | null;
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
 * Periodically collects CPU, memory, and temperature stats.
 * Calls the provided callback with each sample.
 */
export class SystemStatsCollector {
    private timer: ReturnType<typeof setInterval> | null = null;
    private prevCpuTotal = 0;
    private prevCpuIdle = 0;
    private sampleCount = 0;
    private cachedBuildNumber: string | null = null;

    constructor(
        private onStats: (stats: SystemStats) => void,
        private intervalMs = 2000,
    ) {}

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
