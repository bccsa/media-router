import { execFile } from 'node:child_process';
import type { ChronyTracking, TimeSyncSource } from '@media-router/shared-types';

/** Runs a command and returns its stdout, also on a non-zero exit (`is-active` exits 3). */
export type ExecStdout = (cmd: string, args: string[]) => Promise<string>;

export const execStdout: ExecStdout = (cmd, args) =>
    new Promise((resolve) => {
        execFile(cmd, args, { timeout: 5000 }, (_err, stdout) => resolve(String(stdout ?? '')));
    });

const UNITS = ['chronyd.service', 'media-router-ptp4l.service'];

/** `systemctl is-active` prints one state per unit, in argument order. */
export function sourceFromUnits(stdout: string): TimeSyncSource {
    const [chrony, ptp] = stdout.split('\n').map((l) => l.trim());
    // The PTP setup stops chronyd, so both active is a transition: PTP owns the clock.
    if (ptp === 'active') return 'ptp';
    if (chrony === 'active') return 'chrony';
    return 'none';
}

/**
 * `chronyc -c tracking`: ref id, name, stratum, ref time, system offset, last
 * offset, rms, freq, residual, skew, root delay, root dispersion, interval, leap.
 */
export function parseChronyTracking(csv: string): ChronyTracking | null {
    const f = csv.trim().split('\n')[0]?.split(',') ?? [];
    if (f.length < 14) return null;
    const num = (i: number): number => Number(f[i]);
    const [offset, delay, dispersion] = [num(4), num(10), num(11)];
    if (![num(2), offset, delay, dispersion].every(Number.isFinite)) return null;
    // chrony's own bound on the clock error: |offset| + dispersion + delay / 2.
    const estErrorUs = Math.round((Math.abs(offset) + dispersion + delay / 2) * 1e6);
    return { reference: f[1] || f[0], stratum: num(2), estErrorUs, leap: f[13] };
}

/** One poll: who owns the clock, and chrony's view when it does. Read-only, unprivileged. */
export async function pollClockSource(
    exec: ExecStdout = execStdout,
): Promise<{ source: TimeSyncSource; chrony?: ChronyTracking }> {
    const source = sourceFromUnits(await exec('systemctl', ['is-active', ...UNITS]));
    if (source !== 'chrony') return { source };
    const chrony = parseChronyTracking(await exec('chronyc', ['-c', 'tracking']));
    return chrony ? { source, chrony } : { source };
}
