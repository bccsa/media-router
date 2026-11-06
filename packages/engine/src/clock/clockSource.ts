import { execFile } from 'node:child_process';
import type { ChronyTracking, PtpClockState, TimeSyncSource } from '@media-router/shared-types';
import { readPtpClock, readPtpStatusEnv, type ReadText } from './ptpStatus.js';

/** Runs a command and returns its stdout, also on a non-zero exit (`is-active` exits 3). */
export type ExecStdout = (cmd: string, args: string[]) => Promise<string>;

export const execStdout: ExecStdout = (cmd, args) =>
    new Promise((resolve) => {
        execFile(cmd, args, { timeout: 5000 }, (_err, stdout) => resolve(String(stdout ?? '')));
    });

const UNITS = ['chronyd.service', 'media-router-ptp4l.service'];

/** `systemctl is-active` prints one state per unit, in argument order. */
function unitStates(stdout: string): { chrony?: string; ptp?: string } {
    const [chrony, ptp] = stdout.split('\n').map((l) => l.trim());
    return { chrony, ptp };
}

/** Who owns the clock, from `systemctl is-active chronyd ptp4l`. */
export function sourceFromUnits(stdout: string): TimeSyncSource {
    const { chrony, ptp } = unitStates(stdout);
    // On a PTP box chronyd runs only while it owns the clock (a master-capable box as
    // grandmaster, the boot wait, or a slave-only box on the NTP fallback), so chronyd active
    // means chrony.
    if (chrony === 'active') return 'chrony';
    if (ptp === 'active') return 'ptp';
    return 'none';
}

/** `chronyc -c tracking` fields: ref id, name, stratum, ref time, system offset, last offset,
 *  rms, freq, residual, skew, root delay, root dispersion, interval, leap. */
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

export interface ClockSourcePoll {
    source: TimeSyncSource;
    chrony?: ChronyTracking;
    ptp?: PtpClockState;
    /** From status.env, read once a poll (it gives pmc its domain too); false while ptp4l's unit
     *  is inactive, absent without the file. */
    ntpFallback?: boolean;
}

/** One poll: who owns the clock, and that daemon's own view (chrony's tracking, ptp4l's offset).
 *  Read-only, unprivileged. `readPtp: false` leaves ptp4l out. */
export async function pollClockSource(
    exec: ExecStdout = execStdout,
    opts: { readPtp?: boolean; readText?: ReadText } = {},
): Promise<ClockSourcePoll> {
    const [units, env] = await Promise.all([
        exec('systemctl', ['is-active', ...UNITS]),
        readPtpStatusEnv(opts.readText),
    ]);
    const poll: ClockSourcePoll = { source: sourceFromUnits(units) };
    // status.env outlives ptp4l (its runtime directory is kept), so PTP turned off on the
    // fallback leaves it behind: the fallback holds only while ptp4l's unit is not inactive.
    if (env) poll.ntpFallback = env.ntpFallback && unitStates(units).ptp !== 'inactive';
    if (poll.source === 'ptp' && opts.readPtp !== false) {
        const ptp = await readPtpClock(exec, env?.domain ?? 0);
        if (ptp) poll.ptp = ptp;
    } else if (poll.source === 'chrony') {
        const chrony = parseChronyTracking(await exec('chronyc', ['-c', 'tracking']));
        if (chrony) poll.chrony = chrony;
    }
    return poll;
}
