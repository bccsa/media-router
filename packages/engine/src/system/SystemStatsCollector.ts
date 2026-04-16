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
                const cpuPercent = totalDelta > 0 ? Math.round((1 - idleDelta / totalDelta) * 100) : 0;
                this.prevCpuTotal = totalTick;
                this.prevCpuIdle = idleTick;

                const totalMem = os.totalmem();
                const freeMem = os.freemem();
                const memPercent = Math.round(((totalMem - freeMem) / totalMem) * 100);

                let cpuTemp: number | null = null;
                try {
                    const temp = fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf-8');
                    cpuTemp = Math.round(parseInt(temp, 10) / 1000);
                } catch { /* thermal zone not available on this hardware */ }

                const stats: SystemStats = { cpu: cpuPercent, mem: memPercent, temp: cpuTemp };

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
            } catch (err) { log.debug({ err }, 'Stats collection tick failed'); }
        }, this.intervalMs);
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
}
