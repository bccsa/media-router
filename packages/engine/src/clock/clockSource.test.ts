import { describe, it, expect, vi } from 'vitest';
import { parseChronyTracking, pollClockSource, sourceFromUnits } from './clockSource.js';
import { PMC, PTP_STATUS_ENV } from './ptpStatus.js';

// chronyc 4.x CSV column order (from chrony's docs; a gate capture replaces it as a fixture).
const SYNCED =
    'A29FC87B,ntp1.example.org,2,1791234567.123456789,-0.000100000,0.000020000,0.000050000,' +
    '-3.479,0.001,0.010,0.004000000,0.000500000,64.2,Normal\n';
const UNSYNCED =
    '00000000,,0,0.000000000,0.000000000,0.000000000,0.000000000,0.000,0.000,0.000,1.000000000,1.000000000,0.0,Not synchronised\n';

describe('sourceFromUnits', () => {
    it('maps `systemctl is-active chronyd ptp4l` to the clock owner', () => {
        expect(sourceFromUnits('active\ninactive\n')).toBe('chrony');
        expect(sourceFromUnits('inactive\nactive\n')).toBe('ptp');
        expect(sourceFromUnits('inactive\ninactive\n')).toBe('none');
        expect(sourceFromUnits('')).toBe('none');
        // A PTP grandmaster runs both: chronyd disciplines the clock ptp4l serves.
        expect(sourceFromUnits('active\nactive\n')).toBe('chrony');
        // Revoked: ptp4l steers while chronyd stops.
        expect(sourceFromUnits('deactivating\nactive\n')).toBe('ptp');
    });
});

describe('parseChronyTracking', () => {
    it('reads reference, stratum, leap and the estimated error', () => {
        // |−100 µs| + 500 µs dispersion + 4000 µs delay / 2 = 2600 µs
        expect(parseChronyTracking(SYNCED)).toEqual({
            reference: 'ntp1.example.org',
            stratum: 2,
            estErrorUs: 2600,
            leap: 'Normal',
        });
    });

    it('reports an unsynchronised chronyd as such, falling back to the ref id', () => {
        expect(parseChronyTracking(UNSYNCED)).toMatchObject({
            reference: '00000000',
            stratum: 0,
            leap: 'Not synchronised',
        });
    });

    it('rejects anything that is not a tracking line', () => {
        expect(parseChronyTracking('')).toBeNull();
        expect(parseChronyTracking('506 Cannot talk to daemon')).toBeNull();
    });
});

describe('pollClockSource', () => {
    const readText = async () => 'PTP_DOMAIN=0\n';
    const commands = (exec: { mock: { calls: unknown[][] } }) => exec.mock.calls.map(([c]) => c);

    it('asks chronyc only when chrony owns the clock', async () => {
        const exec = vi.fn(async (cmd: string) =>
            cmd === 'systemctl' ? 'inactive\nactive\n' : SYNCED,
        );
        // Under PTP it asks ptp4l instead, which gives no answer here.
        expect(await pollClockSource(exec, { readText })).toEqual({
            source: 'ptp',
            ntpFallback: false,
        });
        expect(commands(exec)).toEqual(['systemctl', PMC]);
        expect(exec).toHaveBeenNthCalledWith(1, 'systemctl', [
            'is-active',
            'chronyd.service',
            'media-router-ptp4l.service',
        ]);

        exec.mockImplementation(async (cmd: string) =>
            cmd === 'systemctl' ? 'active\ninactive\n' : SYNCED,
        );
        const r = await pollClockSource(exec, { readText });
        expect(r.source).toBe('chrony');
        expect(r.chrony?.stratum).toBe(2);
        expect(r.ptp).toBeUndefined();
        expect(exec).toHaveBeenLastCalledWith('chronyc', ['-c', 'tracking']);
    });

    it("carries ptp4l's view when linuxptp owns the clock; readPtp false leaves it out", async () => {
        const pmc =
            '\te45f01.fffe.1a1878-1 seq 0 RESPONSE MANAGEMENT PORT_DATA_SET\n' +
            '\t\tportState               SLAVE\n' +
            '\te45f01.fffe.1a1878-0 seq 1 RESPONSE MANAGEMENT CURRENT_DATA_SET \n' +
            '\t\tstepsRemoved     1\n\t\toffsetFromMaster -812.0\n\t\tmeanPathDelay    41231.0\n';
        const exec = vi.fn(async (cmd: string) =>
            cmd === 'systemctl' ? 'inactive\nactive\n' : pmc,
        );
        expect(await pollClockSource(exec, { readText })).toEqual({
            source: 'ptp',
            ptp: { portState: 'SLAVE', offsetNs: -812, pathDelayNs: 41_231, domain: 0 },
            ntpFallback: false,
        });
        exec.mockClear();
        expect(await pollClockSource(exec, { readPtp: false, readText })).toEqual({
            source: 'ptp',
            ntpFallback: false,
        });
        expect(commands(exec)).toEqual(['systemctl']);
    });

    it('asks chronyc on a PTP grandmaster, where chronyd and ptp4l both run', async () => {
        const exec = vi.fn(async (cmd: string) =>
            cmd === 'systemctl' ? 'active\nactive\n' : SYNCED,
        );
        const grandmaster = async () => 'PTP_DOMAIN=0\nPTP_SLAVE_ONLY=0\nPTP_NTP_FALLBACK=0\n';
        expect(await pollClockSource(exec, { readText: grandmaster })).toMatchObject({
            source: 'chrony',
            chrony: { reference: 'ntp1.example.org', stratum: 2 },
            ntpFallback: false,
        });
        expect(exec).toHaveBeenLastCalledWith('chronyc', ['-c', 'tracking']);
    });

    it("a slave-only box on the NTP fallback: chrony's view, and status.env says why", async () => {
        const exec = vi.fn(async (cmd: string) =>
            cmd === 'systemctl' ? 'active\nactive\n' : SYNCED,
        );
        const read = vi.fn(async () => 'PTP_DOMAIN=0\nPTP_SLAVE_ONLY=1\nPTP_NTP_FALLBACK=1\n');
        expect(await pollClockSource(exec, { readText: read })).toEqual({
            source: 'chrony',
            chrony: { reference: 'ntp1.example.org', stratum: 2, estErrorUs: 2600, leap: 'Normal' },
            ntpFallback: true,
        });
        expect(commands(exec)).toEqual(['systemctl', 'chronyc']);
        // Also with no daemon active (a hand-over's restart) and on a step's poll.
        exec.mockImplementation(async () => 'inactive\nactivating\n');
        expect(await pollClockSource(exec, { readPtp: false, readText: read })).toEqual({
            source: 'none',
            ntpFallback: true,
        });
        expect(read).toHaveBeenCalledTimes(2);
        expect(read).toHaveBeenCalledWith(PTP_STATUS_ENV);
    });

    it('PTP turned off on the fallback: status.env stays in /run, the fallback goes', async () => {
        // The Device Manager's disable stops ptp4l and starts chronyd; ptp4l's runtime
        // directory, status.env in it, is kept.
        const read = async () => 'PTP_DOMAIN=0\nPTP_SLAVE_ONLY=1\nPTP_NTP_FALLBACK=1\n';
        const units = (ptp4l: string) =>
            vi.fn(async (cmd: string) => (cmd === 'systemctl' ? `active\n${ptp4l}\n` : SYNCED));
        expect(await pollClockSource(units('inactive'), { readText: read })).toMatchObject({
            source: 'chrony',
            ntpFallback: false,
        });
        // Any other state keeps it: a restart's stop, or a failed ptp4l, which leaves a PTP box
        // on internet time rather than making it an NTP box.
        for (const ptp4l of ['deactivating', 'failed']) {
            const poll = await pollClockSource(units(ptp4l), { readText: read });
            expect(poll).toMatchObject({ source: 'chrony', ntpFallback: true });
        }
    });

    it('one status.env read a poll gives pmc its domain; a box without one has no fallback', async () => {
        const exec = vi.fn(
            async (cmd: string): Promise<string> =>
                cmd === 'systemctl' ? 'inactive\nactive\n' : '',
        );
        const read = vi.fn(async () => 'PTP_DOMAIN=127\nPTP_SLAVE_ONLY=1\nPTP_NTP_FALLBACK=0\n');
        expect(await pollClockSource(exec, { readText: read })).toEqual({
            source: 'ptp',
            ntpFallback: false,
        });
        expect(read).toHaveBeenCalledTimes(1);
        const pmc = (exec.mock.calls as unknown as Array<[string, string[]]>)[1];
        expect(pmc[0]).toBe(PMC);
        expect(pmc[1].slice(3, 5)).toEqual(['-d', '127']);
        // No PTP on this box: no field, and pmc's default domain if ptp4l were active.
        const none = async (): Promise<string> => {
            throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        };
        exec.mockClear();
        expect(await pollClockSource(exec, { readText: none })).toEqual({ source: 'ptp' });
        expect((exec.mock.calls as unknown as Array<[string, string[]]>)[1][1].slice(3, 5)).toEqual(
            ['-d', '0'],
        );
        exec.mockImplementation(async (cmd: string) =>
            cmd === 'systemctl' ? 'active\ninactive\n' : SYNCED,
        );
        expect(await pollClockSource(exec, { readText: none })).not.toHaveProperty('ntpFallback');
    });
});
