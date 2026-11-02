// ptp4l's own view of the clock while linuxptp steers it (B-198): the kernel's esterror is
// never PTP's (linuxptp does not set it), so the offset from the master comes from ptp4l.
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PtpClockState } from '@media-router/shared-types';
import type { ExecStdout } from './clockSource.js';

/** Reads a small text file; tests stub it. */
export type ReadText = (path: string) => Promise<string>;

const readText: ReadText = (path) => readFile(path, 'utf8');

/** Written (0644) by media-router-ptp-setup.sh before every ptp4l start: the domain in force. */
export const PTP_STATUS_ENV = '/run/media-router-ptp/status.env';
/** ptp4l's read-only management socket: GETs only, mode 0666 (linuxptp 4.4's defaults). */
export const PTP4L_RO_SOCKET = '/var/run/ptp4lro';
/** Where linuxptp installs it; the engine's user manager need not have sbin on its PATH. */
export const PMC = '/usr/sbin/pmc';

let pmcRuns = 0;

/** status.env's PTP_DOMAIN, else 0: ptp4l drops management from another domain. */
export function ptpDomain(env: string): number {
    const m = /^PTP_DOMAIN=(\d{1,3})\s*$/m.exec(env);
    const domain = m ? Number(m[1]) : 0;
    return domain <= 255 ? domain : 0;
}

/** pmc's argv. `-i` is its reply socket, which defaults to root's /var/run; each request is one
 *  argument, there is no shell. */
export function pmcArgs(domain: number, replyPath: string): string[] {
    return [
        '-u',
        '-b',
        '0',
        '-d',
        String(domain),
        '-s',
        PTP4L_RO_SOCKET,
        '-i',
        replyPath,
        'GET PORT_DATA_SET',
        'GET CURRENT_DATA_SET',
    ];
}

export interface PmcBlock {
    /** The management ID: PORT_DATA_SET, CURRENT_DATA_SET, … */
    name: string;
    fields: Map<string, string>;
}

const REPLY = /^\t\S+ seq \d+ RESPONSE MANAGEMENT (\w+)\s*$/;
const FIELD = /^\t\t(\S+)\s+(\S.*?)\s*$/;

/** pmc's replies (pmc.c `pmc_show`): a `<port> seq <n> RESPONSE MANAGEMENT <ID>` line, then
 *  indented `key value` lines. Its "sending:" echoes and error replies end a block. */
export function parsePmcBlocks(text: string): PmcBlock[] {
    const blocks: PmcBlock[] = [];
    let block: PmcBlock | null = null;
    for (const line of text.split('\n')) {
        const reply = REPLY.exec(line);
        if (reply) {
            block = { name: reply[1], fields: new Map() };
            blocks.push(block);
            continue;
        }
        const field = block ? FIELD.exec(line) : null;
        if (field) block!.fields.set(field[1], field[2]);
        else block = null;
    }
    return blocks;
}

const number = (v: string | undefined): number =>
    v !== undefined && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : NaN;

/** PORT_DATA_SET and CURRENT_DATA_SET into PTP's view; null unless both answered. The offset
 *  counts only while the port follows a master (SLAVE, UNCALIBRATED). */
export function parsePtpClock(text: string): PtpClockState | null {
    const blocks = parsePmcBlocks(text);
    const states = blocks
        .filter((b) => b.name === 'PORT_DATA_SET')
        .map((b) => b.fields.get('portState'))
        .filter((s): s is string => !!s);
    const current = blocks.find((b) => b.name === 'CURRENT_DATA_SET')?.fields;
    if (!states.length || !current) return null;
    const steps = number(current.get('stepsRemoved'));
    const offset = number(current.get('offsetFromMaster'));
    const delay = number(current.get('meanPathDelay'));
    if (![steps, offset, delay].every(Number.isFinite)) return null;
    const following = states.find((s) => s === 'SLAVE' || s === 'UNCALIBRATED');
    // A slave-only port that lost its master goes LISTENING with ptp4l's last offset still set.
    if (!following || steps < 1) return { portState: states[0] };
    return {
        portState: following,
        offsetNs: Math.round(offset) || 0,
        pathDelayNs: Math.round(delay) || 0,
    };
}

/** ptp4l's view now, or null when it gives none. Never blocks the loop: pmc is a child that exits
 *  100 ms after its last reply, and the engine's user may use only the read-only socket. */
export async function readPtpClock(
    exec: ExecStdout,
    read: ReadText = readText,
): Promise<PtpClockState | null> {
    let env = '';
    try {
        env = await read(PTP_STATUS_ENV);
    } catch {
        // Not written yet: pmc's and ptp4l's default domain.
    }
    const dir = process.env.XDG_RUNTIME_DIR || tmpdir();
    const reply = join(dir, `mr-pmc-${process.pid}-${++pmcRuns}`);
    return parsePtpClock(await exec(PMC, pmcArgs(ptpDomain(env), reply)));
}
