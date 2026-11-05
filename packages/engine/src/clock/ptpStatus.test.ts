import { describe, it, expect, vi, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import {
    PMC,
    PTP4L_RO_SOCKET,
    PTP_STATUS_ENV,
    parsePmcBlocks,
    parsePtpClock,
    parsePtpStatusEnv,
    pmcArgs,
    ptpDomain,
    readPtpClock,
    readPtpStatusEnv,
} from './ptpStatus.js';

// PORT_DATA_SET is the Device Manager's verbatim capture of a slaved box (PMC_SLAVE in its
// PtpStatus.spec.ts; its copy lost the space after the ID). CURRENT_DATA_SET is as pmc 4.4
// prints it (pmc.c:284-291): PMC_44 below is what it printed, its bytes unedited.
const port = (state: string) =>
    [
        '\te45f01.fffe.1a1878-1 seq 0 RESPONSE MANAGEMENT PORT_DATA_SET',
        '\t\tportIdentity            e45f01.fffe.1a1878-1',
        `\t\tportState               ${state}`,
        '\t\tlogMinDelayReqInterval  0',
        '\t\tpeerMeanPathDelay       0',
        '\t\tlogAnnounceInterval     1',
        '\t\tannounceReceiptTimeout  3',
        '\t\tlogSyncInterval         -3',
        '\t\tdelayMechanism          1',
        '\t\tlogMinPdelayReqInterval 0',
        '\t\tversionNumber           2',
        '',
    ].join('\n');
const current = (steps: number, offset: string, delay: string) =>
    [
        '\te45f01.fffe.1a1878-0 seq 1 RESPONSE MANAGEMENT CURRENT_DATA_SET ',
        `\t\tstepsRemoved     ${steps}`,
        `\t\toffsetFromMaster ${offset}`,
        `\t\tmeanPathDelay    ${delay}`,
        '',
    ].join('\n');
const SENT = 'sending: GET PORT_DATA_SET\nsending: GET CURRENT_DATA_SET\n';
/** A slaved box: both requests echoed, then both replies (pmc's usual order). */
const SLAVE = SENT + port('SLAVE') + current(1, '-812.0', '41231.0');
/** pmc 4.4 (the image's source) run as the engine runs it, against a stand-in for ptp4l's
 *  read-only socket answering SLAVE, -812 ns, 41231 ns (B-198's row says how). */
const PMC_44 =
    'sending: GET PORT_DATA_SET\nsending: GET CURRENT_DATA_SET\n' +
    '\te45f01.fffe.1a1878-1 seq 0 RESPONSE MANAGEMENT PORT_DATA_SET \n' +
    '\t\tportIdentity            e45f01.fffe.1a1878-1\n' +
    '\t\tportState               SLAVE\n' +
    '\t\tlogMinDelayReqInterval  0\n' +
    '\t\tpeerMeanPathDelay       0\n' +
    '\t\tlogAnnounceInterval     1\n' +
    '\t\tannounceReceiptTimeout  3\n' +
    '\t\tlogSyncInterval         -3\n' +
    '\t\tdelayMechanism          1\n' +
    '\t\tlogMinPdelayReqInterval 0\n' +
    '\t\tversionNumber           2\n' +
    '\te45f01.fffe.1a1878-0 seq 1 RESPONSE MANAGEMENT CURRENT_DATA_SET \n' +
    '\t\tstepsRemoved     1\n' +
    '\t\toffsetFromMaster -812.0\n' +
    '\t\tmeanPathDelay    41231.0\n';
/** pmc prints each echo as it sends, so a reply can come before the second echo. */
const SLAVE_INTERLEAVED =
    'sending: GET PORT_DATA_SET\n' +
    port('SLAVE') +
    'sending: GET CURRENT_DATA_SET\n' +
    current(1, '-812.0', '41231.0');

describe('parsePmcBlocks', () => {
    it("splits pmc's replies by management ID, skipping its echoes", () => {
        const blocks = parsePmcBlocks(SLAVE_INTERLEAVED);
        expect(blocks.map((b) => b.name)).toEqual(['PORT_DATA_SET', 'CURRENT_DATA_SET']);
        expect(blocks[0].fields.get('portState')).toBe('SLAVE');
        expect(blocks[0].fields.get('logSyncInterval')).toBe('-3');
        expect(blocks[1].fields.get('offsetFromMaster')).toBe('-812.0');
    });

    it('an error reply, an empty TLV or a stray line opens no block', () => {
        const text =
            '\te45f01.fffe.1a1878-0 seq 0 RESPONSE MANAGEMENT_ERROR_STATUS \n' +
            '\t\tstepsRemoved     1\n' +
            '\te45f01.fffe.1a1878-0 seq 1 RESPONSE MANAGEMENT empty-tlv \n' +
            '\t\toffsetFromMaster -1.0\n';
        expect(parsePmcBlocks(text)).toEqual([]);
    });
});

describe('parsePtpClock', () => {
    it("reads a slaved port's offset from its master and path delay, in ns", () => {
        const want = { portState: 'SLAVE', offsetNs: -812, pathDelayNs: 41_231 };
        expect(parsePtpClock(PMC_44)).toEqual(want);
        expect(parsePtpClock(SLAVE)).toEqual(want);
        expect(parsePtpClock(SLAVE_INTERLEAVED)).toEqual(want);
        // Sub-ns digits round; a rounded -0 is 0.
        expect(parsePtpClock(SENT + port('SLAVE') + current(1, '-0.4', '3216.5'))).toEqual({
            portState: 'SLAVE',
            offsetNs: 0,
            pathDelayNs: 3217,
        });
    });

    it('UNCALIBRATED, while the servo locks, still has a figure: ptp4l clamps it at ±2^47 ns', () => {
        // A box that boots 214 days behind, before the lock's step (tmv.h:30-31).
        expect(
            parsePtpClock(
                SENT + port('UNCALIBRATED') + current(1, '-140737488355328.0', '41231.0'),
            ),
        ).toEqual({
            portState: 'UNCALIBRATED',
            offsetNs: -140_737_488_355_328,
            pathDelayNs: 41_231,
        });
    });

    it('no figure once the port follows no master, though ptp4l keeps the last one', () => {
        // A slave-only port whose master went: LISTENING, CURRENT_DATA_SET left as it was.
        expect(parsePtpClock(SENT + port('LISTENING') + current(1, '-812.0', '41231.0'))).toEqual({
            portState: 'LISTENING',
        });
        // Its own grandmaster: ptp4l zeroes the data set.
        expect(parsePtpClock(SENT + port('MASTER') + current(0, '0.0', '0.0'))).toEqual({
            portState: 'MASTER',
        });
        expect(parsePtpClock(SENT + port('SLAVE') + current(0, '0.0', '0.0'))).toEqual({
            portState: 'SLAVE',
        });
    });

    it('null unless both data sets answered with numbers', () => {
        expect(parsePtpClock('')).toBeNull();
        expect(parsePtpClock(SENT)).toBeNull(); // ptp4l gave no answer (another domain, say)
        expect(parsePtpClock(SENT + port('SLAVE'))).toBeNull();
        expect(parsePtpClock(SENT + current(1, '-812.0', '41231.0'))).toBeNull();
        expect(parsePtpClock(SENT + port('SLAVE') + current(1, 'nan', '41231.0'))).toBeNull();
        expect(parsePtpClock('failed to create pmc\n')).toBeNull();
    });
});

describe('ptpDomain', () => {
    it("takes status.env's PTP_DOMAIN, else pmc's default 0", () => {
        const env =
            'PTP_INTERFACE=eth0\nPTP_PROFILE=smpte-2059-2\nPTP_DOMAIN=127\nPTP_SLAVE_ONLY=1\n';
        expect(ptpDomain(env)).toBe(127);
        expect(ptpDomain('PTP_DOMAIN=0\n')).toBe(0);
        expect(ptpDomain('')).toBe(0);
        expect(ptpDomain('PTP_DOMAIN=\n')).toBe(0);
        expect(ptpDomain('PTP_DOMAIN=999\n')).toBe(0);
        expect(ptpDomain('X_PTP_DOMAIN=5\n')).toBe(0);
    });
});

/** status.env as media-router-ptp-setup.sh (Yocto 608ef45c) wrote it through its own test
 *  harness: a slave-only box, software timestamping, at the start that applied the fallback. */
const FALLBACK_ENV =
    'PTP_INTERFACE=lo\nPTP_PROFILE=aes67\nPTP_DOMAIN=0\nPTP_PRIORITY1=200\nPTP_SLAVE_ONLY=1\n' +
    'PTP_TIMESTAMPING=software\nPTP_TIMESTAMPING_DETECTED=software\nPTP_PHC=\nPTP_NTP_FALLBACK=1\n';
const withKeys = (keys: Record<string, string | null>) =>
    Object.entries(keys).reduce(
        (env, [key, value]) =>
            value === null
                ? env.replace(new RegExp(`^${key}=.*\n`, 'm'), '')
                : env.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`),
        FALLBACK_ENV,
    );

describe('parsePtpStatusEnv', () => {
    it('the NTP fallback is a slave-only box whose ptp4l start applied it: both markers', () => {
        expect(parsePtpStatusEnv(FALLBACK_ENV)).toEqual({ domain: 0, ntpFallback: true });
        // The return's start, as the setup writes it.
        expect(parsePtpStatusEnv(withKeys({ PTP_NTP_FALLBACK: '0' })).ntpFallback).toBe(false);
        // A master-capable box never falls back: the setup voids a marker there.
        expect(parsePtpStatusEnv(withKeys({ PTP_SLAVE_ONLY: '0' })).ntpFallback).toBe(false);
        expect(
            parsePtpStatusEnv(withKeys({ PTP_DOMAIN: '127', PTP_PROFILE: 'smpte-2059-2' })),
        ).toEqual({ domain: 127, ntpFallback: true });
    });

    it("a missing or empty key reads as the setup's default 0", () => {
        // A setup older than the fallback (before Yocto 7347a244) writes no PTP_NTP_FALLBACK.
        expect(parsePtpStatusEnv(withKeys({ PTP_NTP_FALLBACK: null })).ntpFallback).toBe(false);
        expect(parsePtpStatusEnv(withKeys({ PTP_SLAVE_ONLY: null })).ntpFallback).toBe(false);
        expect(parsePtpStatusEnv(withKeys({ PTP_SLAVE_ONLY: '' })).ntpFallback).toBe(false);
        expect(parsePtpStatusEnv(withKeys({ PTP_NTP_FALLBACK: '' })).ntpFallback).toBe(false);
        expect(parsePtpStatusEnv('X_PTP_SLAVE_ONLY=1\nX_PTP_NTP_FALLBACK=1\n')).toEqual({
            domain: 0,
            ntpFallback: false,
        });
        expect(parsePtpStatusEnv('')).toEqual({ domain: 0, ntpFallback: false });
    });
});

describe('readPtpStatusEnv', () => {
    it('reads status.env once; null when there is none (no PTP, or before its first start)', async () => {
        const read = vi.fn(async () => FALLBACK_ENV);
        expect(await readPtpStatusEnv(read)).toEqual({ domain: 0, ntpFallback: true });
        expect(read).toHaveBeenCalledTimes(1);
        expect(read).toHaveBeenCalledWith(PTP_STATUS_ENV);
        const missing = async (): Promise<string> => {
            throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        };
        expect(await readPtpStatusEnv(missing)).toBeNull();
    });
});

describe('pmcArgs', () => {
    it("asks the read-only socket in ptp4l's domain, replies to a socket the engine may bind", () => {
        expect(pmcArgs(127, '/run/user/1001/mr-pmc-1-1')).toEqual([
            '-u',
            '-b',
            '0',
            '-d',
            '127',
            '-s',
            '/var/run/ptp4lro',
            '-i',
            '/run/user/1001/mr-pmc-1-1',
            'GET PORT_DATA_SET',
            'GET CURRENT_DATA_SET',
        ]);
        expect(PTP4L_RO_SOCKET).toBe('/var/run/ptp4lro');
    });
});

describe('readPtpClock', () => {
    afterEach(() => vi.unstubAllEnvs());

    it('runs pmc in the domain given, each run with its own reply socket', async () => {
        vi.stubEnv('XDG_RUNTIME_DIR', '/run/user/1001');
        const exec = vi.fn(async () => SLAVE);
        expect(await readPtpClock(exec, 127)).toEqual({
            portState: 'SLAVE',
            offsetNs: -812,
            pathDelayNs: 41_231,
        });
        await readPtpClock(exec, 127);
        const calls = exec.mock.calls as unknown as Array<[string, string[]]>;
        expect(calls.map(([cmd]) => cmd)).toEqual([PMC, PMC]);
        const replies = calls.map(([, args]) => args[args.indexOf('-i') + 1]);
        for (const r of replies) expect(r).toMatch(/^\/run\/user\/1001\/mr-pmc-\d+-\d+$/);
        expect(replies[0]).not.toBe(replies[1]);
        expect(calls[0][1].slice(3, 5)).toEqual(['-d', '127']);
    });

    it('no runtime dir: the temp dir; no answer: null', async () => {
        vi.stubEnv('XDG_RUNTIME_DIR', '');
        const exec = vi.fn(async () => 'sending: GET PORT_DATA_SET\n');
        expect(await readPtpClock(exec, 0)).toBeNull();
        const args = (exec.mock.calls as unknown as Array<[string, string[]]>)[0][1];
        expect(args.slice(3, 5)).toEqual(['-d', '0']);
        expect(args[args.indexOf('-i') + 1].startsWith(`${tmpdir()}/mr-pmc-`)).toBe(true);
    });
});
