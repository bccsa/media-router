import { describe, it, expect } from 'vitest';
import { KERNEL_ESTERROR_UNSET_US, ptpErrorText } from './index';

describe('ptpErrorText', () => {
    it("gives PTP's offset from its master, scaled, with the path delay", () => {
        const text = (offsetNs: number, pathDelayNs: number) =>
            ptpErrorText({ portState: 'SLAVE', offsetNs, pathDelayNs });
        expect(text(-812, 41_231)).toBe('±812 ns (PTP offset from master, path delay 41.2 µs)');
        expect(text(0, 999)).toBe('±0 ns (PTP offset from master, path delay 999 ns)');
        expect(text(1_000, 2_600_000)).toBe('±1.0 µs (PTP offset from master, path delay 2.6 ms)');
        // Before the lock's step on a box that booted days behind: ptp4l's clamp, 2^47 ns.
        expect(text(-140_737_488_355_328, 41_231)).toBe(
            '±140737.5 s (PTP offset from master, path delay 41.2 µs)',
        );
    });

    it('no figure: the port state when ptp4l answered, else just PTP', () => {
        expect(ptpErrorText({ portState: 'LISTENING' })).toBe('n/a (PTP port LISTENING)');
        expect(ptpErrorText(undefined)).toBe('n/a (PTP)');
    });

    it("names the kernel's unset esterror, NTP_PHASE_LIMIT in µs", () => {
        expect(KERNEL_ESTERROR_UNSET_US).toBe(16_000_000);
    });
});
