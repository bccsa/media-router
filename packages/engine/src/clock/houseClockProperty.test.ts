import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { HouseEpoch, TimeSyncState } from '@media-router/shared-types';
import { KERNEL_ESTERROR_UNSET_US } from '@media-router/shared-types';
import {
    HOUSE_CLOCK_E_OVERRIDE_ENV,
    houseClockErrorClass,
    houseClockFields,
    houseClockGstString,
    houseClockKey,
    houseClockPipelineProperty,
} from './houseClockProperty.js';
import { parsePtpClock } from './ptpStatus.js';
import { GstPluginBase } from '../plugins/GstPluginBase.js';
import type { ModuleServices, PipelineDescription } from '../plugins/PluginModule.js';
import type { HouseClock } from './HouseClock.js';

// B-220 (WI-P5-9): the `house-clock` value every egress writer and restamp is given.

const E = 1_760_283_215_123_456_789n;
const epoch = (over: Partial<HouseEpoch> = {}): HouseEpoch => ({
    eNs: E,
    seq: 3,
    latchedAtMonoNs: 1_000_000_000n,
    traceable: true,
    reason: 'start',
    source: 'chrony',
    taiOffsetS: 37,
    ...over,
});
const chrony = (over: Partial<TimeSyncState> = {}): TimeSyncState => ({
    source: 'chrony',
    synced: true,
    traceable: true,
    taiOffsetS: 37,
    estErrorUs: 1200,
    maxErrorUs: 5000,
    freqPpm: 1.5,
    waitingForSync: false,
    epochSeq: 3,
    sidecar: true,
    ...over,
});
const ptp = (over: Partial<TimeSyncState> = {}): TimeSyncState =>
    chrony({
        source: 'ptp',
        estErrorUs: KERNEL_ESTERROR_UNSET_US,
        ptp: {
            portState: 'SLAVE',
            offsetNs: -812,
            pathDelayNs: 41_231,
            domain: 127,
            gmIdentity: '2C-CF-67-FF-FE-76-E6-69',
        },
        ...over,
    });
const NO_ENV = {};

/** The value as gst_structure_from_string reads it: name, then `key=(type)value` fields. */
function parse(value: string): { name: string; fields: Map<string, [string, string]> } {
    const [name, ...rest] = value.split(', ');
    const fields = new Map<string, [string, string]>();
    for (const f of rest) {
        const m = /^([a-z-]+)=\((\w+)\)(.*)$/.exec(f);
        if (!m) throw new Error(`unreadable field ${f}`);
        fields.set(m[1], [m[2], m[3]]);
    }
    return { name, fields };
}

describe('houseClockGstString', () => {
    it('serialises chapter 9 part 4.6, pinned, and reads back field by field', () => {
        const value = houseClockGstString(epoch(), chrony(), NO_ENV);
        expect(value).toBe(
            'house-clock, e-ns=(gint64)1760283215123456789, seq=(uint)3, ' +
                'traceable=(boolean)true, disciplined=(boolean)true, source=(string)ntp, ' +
                'error-us=(uint)1200, tai-offset-s=(int)37, ptp-domain=(int)-1, gm=(string)""',
        );
        const { name, fields } = parse(value);
        expect(name).toBe('house-clock');
        expect(Object.fromEntries(fields)).toEqual({
            'e-ns': ['gint64', '1760283215123456789'],
            seq: ['uint', '3'],
            traceable: ['boolean', 'true'],
            disciplined: ['boolean', 'true'],
            source: ['string', 'ntp'],
            'error-us': ['uint', '1200'],
            'tai-offset-s': ['int', '37'],
            'ptp-domain': ['int', '-1'],
            gm: ['string', '""'],
        });
    });

    it('GStreamer reads it back as written: gst_structure_to_string of its parse, recorded', () => {
        // GStreamer 1.28.2 on the dev Pi (B-220's row): to_string adds ';' and drops the quotes
        // around a gm without spaces.
        const st = ptp();
        expect(houseClockGstString(epoch(), st, NO_ENV) + ';').toBe(
            'house-clock, e-ns=(gint64)1760283215123456789, seq=(uint)3, traceable=(boolean)true, ' +
                'disciplined=(boolean)true, source=(string)ptp, error-us=(uint)1, ' +
                'tai-offset-s=(int)37, ptp-domain=(int)127, gm=(string)"2C-CF-67-FF-FE-76-E6-69";',
        );
        const GST_READ_BACK =
            'house-clock, e-ns=(gint64)1760283215123456789, seq=(uint)3, traceable=(boolean)true, ' +
            'disciplined=(boolean)true, source=(string)ptp, error-us=(uint)1, ' +
            'tai-offset-s=(int)37, ptp-domain=(int)127, gm=(string)2C-CF-67-FF-FE-76-E6-69;';
        expect(houseClockGstString(epoch(), st, NO_ENV).replace(/"/g, '') + ';').toBe(
            GST_READ_BACK,
        );
        expect(houseClockGstString(null, null, NO_ENV) + ';').toBe(
            'house-clock, e-ns=(gint64)0, seq=(uint)0, traceable=(boolean)false, ' +
                'disciplined=(boolean)false, source=(string)none, tai-offset-s=(int)0, ' +
                'ptp-domain=(int)-1, gm=(string)"";',
        );
    });

    it('E above 2^53 is exact', () => {
        const eNs = (1n << 53n) + 1n; // 9007199254740993: a double would read ...992
        const { fields } = parse(houseClockGstString(epoch({ eNs }), chrony(), NO_ENV));
        expect(BigInt(fields.get('e-ns')![1])).toBe(eNs);
        const max = (1n << 63n) - 1n;
        const top = parse(houseClockGstString(epoch({ eNs: max }), chrony(), NO_ENV));
        expect(top.fields.get('e-ns')![1]).toBe('9223372036854775807');
    });

    it('PTP: the offset from the master as the error, the domain and the grandmaster', () => {
        const { fields } = parse(houseClockGstString(epoch(), ptp(), NO_ENV));
        expect(fields.get('source')).toEqual(['string', 'ptp']);
        expect(fields.get('error-us')).toEqual(['uint', '1']); // 812 ns, rounded up
        expect(fields.get('ptp-domain')).toEqual(['int', '127']);
        expect(fields.get('gm')).toEqual(['string', '"2C-CF-67-FF-FE-76-E6-69"']);
        // Never the kernel's figure, whatever it holds (B-198).
        const big = ptp({ estErrorUs: 3 });
        big.ptp!.offsetNs = -2_500_000;
        expect(parse(houseClockGstString(epoch(), big, NO_ENV)).fields.get('error-us')).toEqual([
            'uint',
            '2500',
        ]);
    });

    it('PTP with no offset (ptp4l silent, or the box the grandmaster): error-us left out, class 0xFF', () => {
        const master = ptp({
            ptp: { portState: 'MASTER', domain: 0, gmIdentity: '2C-CF-67-FF-FE-76-E6-69' },
        });
        const f = houseClockFields(epoch(), master, NO_ENV);
        expect(f.errorUs).toBeUndefined();
        expect(houseClockErrorClass(f.errorUs)).toBe(0xff);
        const { fields } = parse(houseClockGstString(epoch(), master, NO_ENV));
        expect(fields.has('error-us')).toBe(false);
        expect(fields.get('ptp-domain')).toEqual(['int', '0']);
        expect(fields.get('gm')).toEqual(['string', '"2C-CF-67-FF-FE-76-E6-69"']);
        // ptp4l gave no answer: no domain, no grandmaster either.
        const silent = parse(houseClockGstString(epoch(), ptp({ ptp: undefined }), NO_ENV));
        expect(silent.fields.has('error-us')).toBe(false);
        expect(silent.fields.get('ptp-domain')).toEqual(['int', '-1']);
        expect(silent.fields.get('gm')).toEqual(['string', '""']);
    });

    it("the NTP fallback is source=ntp with chrony's error, whatever ptp4l reports", () => {
        const f = houseClockFields(epoch(), ptp({ ntpFallback: true, estErrorUs: 900 }), NO_ENV);
        expect(f.source).toBe('ntp');
        expect(f.errorUs).toBe(900);
        expect(f.ptpDomain).toBe(-1);
        expect(f.gm).toBe('');
        expect(houseClockFields(epoch(), chrony({ ntpFallback: true }), NO_ENV).source).toBe('ntp');
    });

    it('the kernel esterror still unset, or no time daemon: error unknown', () => {
        const unset = chrony({ estErrorUs: KERNEL_ESTERROR_UNSET_US });
        expect(houseClockFields(epoch(), unset, NO_ENV).errorUs).toBeUndefined();
        const none = houseClockFields(
            epoch({ traceable: false }),
            chrony({ source: 'none', synced: true, traceable: false, estErrorUs: 40 }),
            NO_ENV,
        );
        expect(none).toMatchObject({ source: 'none', disciplined: false, traceable: false });
        expect(none.errorUs).toBeUndefined();
    });

    it('disciplined = synced and a daemon owns the clock', () => {
        expect(houseClockFields(epoch(), chrony({ synced: false }), NO_ENV).disciplined).toBe(
            false,
        );
        expect(houseClockFields(epoch(), ptp(), NO_ENV).disciplined).toBe(true);
    });

    it('no epoch or no clock: E 0, seq 0, nothing declared', () => {
        expect(houseClockGstString(null, null, NO_ENV)).toBe(
            'house-clock, e-ns=(gint64)0, seq=(uint)0, traceable=(boolean)false, ' +
                'disciplined=(boolean)false, source=(string)none, tai-offset-s=(int)0, ' +
                'ptp-domain=(int)-1, gm=(string)""',
        );
    });

    it('MR_HOUSE_CLOCK_E_OVERRIDE_NS replaces E, seq kept; anything not an int64 is ignored', () => {
        const env = { [HOUSE_CLOCK_E_OVERRIDE_ENV]: '9223372036854775807' };
        const f = houseClockFields(epoch(), chrony(), env);
        expect(f).toMatchObject({ eNs: (1n << 63n) - 1n, seq: 3, eOverridden: true });
        expect(houseClockGstString(epoch(), chrony(), env)).toContain(
            'e-ns=(gint64)9223372036854775807, seq=(uint)3,',
        );
        for (const bad of ['9223372036854775808', '1e18', '0x10', ' 5', ''])
            expect(
                houseClockFields(epoch(), chrony(), { [HOUSE_CLOCK_E_OVERRIDE_ENV]: bad }).eNs,
            ).toBe(E);
        expect(
            houseClockFields(epoch(), chrony(), { [HOUSE_CLOCK_E_OVERRIDE_ENV]: '-5' }).eNs,
        ).toBe(-5n);
    });

    it('quoted for a pipeline string: the inner quotes escaped', () => {
        expect(houseClockPipelineProperty('house-clock, gm=(string)""')).toBe(
            'house-clock="house-clock, gm=(string)\\"\\""',
        );
    });

    it("a gmIdentity parsed from pmc reaches the value in RFC 7273's form", () => {
        const text =
            '\te45f01.fffe.1a1878-1 seq 0 RESPONSE MANAGEMENT PORT_DATA_SET\n' +
            '\t\tportState               SLAVE\n' +
            '\te45f01.fffe.1a1878-0 seq 1 RESPONSE MANAGEMENT CURRENT_DATA_SET\n' +
            '\t\tstepsRemoved     1\n\t\toffsetFromMaster -812.0\n\t\tmeanPathDelay    41231.0\n' +
            '\te45f01.fffe.1a1878-0 seq 2 RESPONSE MANAGEMENT PARENT_DATA_SET\n' +
            '\t\tgrandmasterIdentity                   2ccf67.fffe.76e669\n';
        const state = ptp({ ptp: { ...parsePtpClock(text)!, domain: 0 } });
        expect(houseClockFields(epoch(), state, NO_ENV).gm).toBe('2C-CF-67-FF-FE-76-E6-69');
    });
});

describe('houseClockErrorClass', () => {
    it('is hcdesc::error_class: ceil(log2(max(1, µs))) up to 31, 0xFF unknown', () => {
        expect(houseClockErrorClass(1200)).toBe(11);
        expect(houseClockErrorClass(1024)).toBe(10);
        expect(houseClockErrorClass(1025)).toBe(11);
        expect(houseClockErrorClass(0)).toBe(0);
        expect(houseClockErrorClass(1)).toBe(0);
        expect(houseClockErrorClass(2)).toBe(1);
        expect(houseClockErrorClass(0xffff_ffff)).toBe(31);
        expect(houseClockErrorClass(undefined)).toBe(0xff);
        expect(houseClockErrorClass(-1)).toBe(0xff);
        expect(houseClockErrorClass(NaN)).toBe(0xff);
    });
});

describe('houseClockKey', () => {
    it('moves with a field the descriptor carries, the error only by class', () => {
        const key = (s: TimeSyncState, e = epoch()) =>
            houseClockKey(houseClockFields(e, s, NO_ENV));
        const base = key(chrony({ estErrorUs: 1100 }));
        expect(key(chrony({ estErrorUs: 2048 }))).toBe(base); // still class 11
        expect(key(chrony({ estErrorUs: 2049 }))).not.toBe(base);
        expect(key(chrony({ estErrorUs: 1100, freqPpm: 9, maxErrorUs: 1 }))).toBe(base);
        expect(key(chrony({ estErrorUs: 1100, taiOffsetS: 0 }))).not.toBe(base);
        expect(key(chrony({ estErrorUs: 1100, synced: false }))).not.toBe(base);
        expect(key(chrony({ estErrorUs: 1100 }), epoch({ seq: 4 }))).not.toBe(base);
    });
});

/** HouseClock as the binding sees it: epoch(), state() and its two events. */
class FakeClock extends EventEmitter {
    ep: HouseEpoch | null = epoch();
    st: TimeSyncState = chrony();
    epoch(): HouseEpoch | null {
        return this.ep;
    }
    state(): TimeSyncState {
        return this.st;
    }
    reEpoch(eNs: bigint): void {
        this.ep = epoch({ eNs, seq: this.ep!.seq + 1 });
        this.emit('epoch', this.ep);
        this.emit('state', this.st);
    }
    setState(st: TimeSyncState): void {
        this.st = st;
        this.emit('state', st);
    }
}

class Writer extends GstPluginBase {
    built = '';
    buildPipeline(): PipelineDescription {
        this.built = this.houseClockProperty();
        return { pipeline: `fakesrc ! mrtsegress name=eg ${this.built} ! fakesink` };
    }
    bind(): void {
        this.bindHouseClock(['eg', 'rs']);
    }
}

function writer(clock: FakeClock) {
    const mod = new Writer();
    const setProperty = vi.fn(async (_el: string, _prop: string, _value: unknown) => undefined);
    (mod as unknown as { childProcess: unknown }).childProcess = {
        isRunning: true,
        setProperty,
        stop: async () => undefined,
    };
    (mod as unknown as { services: Partial<ModuleServices> }).services = {
        houseClock: clock as unknown as HouseClock,
    };
    return { mod, setProperty };
}

describe('GstPluginBase.bindHouseClock', () => {
    it('the build value goes in the pipeline string; a bind with nothing moved pushes nothing', () => {
        const clock = new FakeClock();
        const { mod, setProperty } = writer(clock);
        mod.buildPipeline();
        expect(mod.built).toBe(
            houseClockPipelineProperty(houseClockGstString(clock.ep, clock.st, NO_ENV)),
        );
        mod.bind();
        expect(setProperty).not.toHaveBeenCalled();
    });

    it('a re-epoch pushes once per element', () => {
        const clock = new FakeClock();
        const { mod, setProperty } = writer(clock);
        mod.buildPipeline();
        mod.bind();
        clock.reEpoch(E + 2_000_000_000n);
        expect(setProperty).toHaveBeenCalledTimes(2);
        const value = houseClockGstString(clock.ep, clock.st, NO_ENV);
        expect(setProperty).toHaveBeenCalledWith('eg', 'house-clock', value);
        expect(setProperty).toHaveBeenCalledWith('rs', 'house-clock', value);
        expect(value).toContain('e-ns=(gint64)1760283217123456789, seq=(uint)4,');
    });

    it('a state change inside one error class pushes nothing; a class change pushes', () => {
        const clock = new FakeClock();
        const { mod, setProperty } = writer(clock);
        mod.buildPipeline();
        mod.bind();
        clock.setState(chrony({ estErrorUs: 1900, freqPpm: 7 })); // 1200 → 1900: class 11
        expect(setProperty).not.toHaveBeenCalled();
        clock.setState(chrony({ estErrorUs: 2100 })); // class 12
        expect(setProperty).toHaveBeenCalledTimes(2);
        expect(setProperty.mock.calls[0][2]).toContain('error-us=(uint)2100');
    });

    it('a move between the build and the bind is pushed at the bind', () => {
        const clock = new FakeClock();
        const { mod, setProperty } = writer(clock);
        mod.buildPipeline();
        clock.st = chrony({ synced: false });
        mod.bind();
        expect(setProperty).toHaveBeenCalledTimes(2);
        expect(setProperty.mock.calls[0][2]).toContain('disciplined=(boolean)false');
    });

    it('onStop unsubscribes; a second bind replaces the first', async () => {
        const clock = new FakeClock();
        const { mod, setProperty } = writer(clock);
        mod.buildPipeline();
        mod.bind();
        mod.bind();
        expect(clock.listenerCount('epoch')).toBe(1);
        expect(clock.listenerCount('state')).toBe(1);
        await mod.onStop();
        expect(clock.listenerCount('epoch')).toBe(0);
        expect(clock.listenerCount('state')).toBe(0);
        clock.reEpoch(E + 1n);
        expect(setProperty).not.toHaveBeenCalled();
    });

    it('no house clock (tests, tools): the build value declares nothing, the bind is a no-op', () => {
        const mod = new Writer();
        mod.buildPipeline();
        expect(mod.built).toBe(houseClockPipelineProperty(houseClockGstString(null, null, NO_ENV)));
        expect(() => mod.bind()).not.toThrow();
    });
});
