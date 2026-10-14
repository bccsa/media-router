import { describe, it, expect, vi } from 'vitest';
import { parseChronyTracking, pollClockSource, sourceFromUnits } from './clockSource.js';

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
    it('asks chronyc only when chrony owns the clock', async () => {
        const exec = vi.fn(async (cmd: string) =>
            cmd === 'systemctl' ? 'inactive\nactive\n' : SYNCED,
        );
        expect(await pollClockSource(exec)).toEqual({ source: 'ptp' });
        expect(exec).toHaveBeenCalledOnce();
        expect(exec).toHaveBeenCalledWith('systemctl', [
            'is-active',
            'chronyd.service',
            'media-router-ptp4l.service',
        ]);

        exec.mockImplementation(async (cmd: string) =>
            cmd === 'systemctl' ? 'active\ninactive\n' : SYNCED,
        );
        const r = await pollClockSource(exec);
        expect(r.source).toBe('chrony');
        expect(r.chrony?.stratum).toBe(2);
        expect(exec).toHaveBeenLastCalledWith('chronyc', ['-c', 'tracking']);
    });

    it('asks chronyc on a PTP grandmaster, where chronyd and ptp4l both run', async () => {
        const exec = vi.fn(async (cmd: string) =>
            cmd === 'systemctl' ? 'active\nactive\n' : SYNCED,
        );
        expect(await pollClockSource(exec)).toMatchObject({
            source: 'chrony',
            chrony: { reference: 'ntp1.example.org', stratum: 2 },
        });
        expect(exec).toHaveBeenLastCalledWith('chronyc', ['-c', 'tracking']);
    });
});
