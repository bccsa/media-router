// The `house-clock` property of mrtsegress and mrtsrestamp (plan ch. 9 part 4.6, B-220): the
// engine's E and the sync state its descriptor declares, as one serialised GstStructure, so
// every writer and restamp on the box sees the same values.
import { KERNEL_ESTERROR_UNSET_US, createLogger } from '@media-router/shared-types';
import type { HouseEpoch, TimeSyncState } from '@media-router/shared-types';
import { quoteGstString } from '../plugins/busHelpers.js';

const log = createLogger('clock');

/** Test only (R19): the E every `house-clock` value carries, decimal ns, so a test can place the
 *  wire's 2^33 wrap minutes after start. Warned at each use. */
export const HOUSE_CLOCK_E_OVERRIDE_ENV = 'MR_HOUSE_CLOCK_E_OVERRIDE_NS';

/** The descriptor's sync_source: chrony is `ntp`, also on MR-048b's NTP fallback. */
export type HouseClockSource = 'ntp' | 'ptp' | 'none';

/** What `house-clock` carries. `errorUs` undefined = unknown (descriptor class 0xFF). */
export interface HouseClockFields {
    eNs: bigint;
    seq: number;
    traceable: boolean;
    disciplined: boolean;
    source: HouseClockSource;
    errorUs?: number;
    taiOffsetS: number;
    /** −1 unless the source is PTP and ptp4l answered. */
    ptpDomain: number;
    /** RFC 7273's form, or '' when not known. */
    gm: string;
    /** E is HOUSE_CLOCK_E_OVERRIDE_ENV's: warned at each value serialised. */
    eOverridden?: boolean;
}

const INT64_MAX = (1n << 63n) - 1n;
const UINT32_MAX = 0xffff_ffff;

/** The override's E, or undefined when unset or not a decimal int64 (warned). */
function overrideENs(env: NodeJS.ProcessEnv): bigint | undefined {
    const text = env[HOUSE_CLOCK_E_OVERRIDE_ENV];
    if (text === undefined || text === '') return undefined;
    const e = /^-?\d{1,19}$/.test(text) ? BigInt(text) : undefined;
    if (e === undefined || e > INT64_MAX || e < -INT64_MAX - 1n) {
        log.warn(`clock: ${HOUSE_CLOCK_E_OVERRIDE_ENV}=${text} is not a decimal int64 — ignored`);
        return undefined;
    }
    return e;
}

/** The clock error the descriptor declares, µs: PTP's |offset from master| under PTP (never the
 *  kernel's figure, B-198), else the kernel's esterror that chrony writes; unknown while unset. */
function errorUs(state: TimeSyncState, source: HouseClockSource): number | undefined {
    if (source === 'none') return undefined;
    if (source === 'ptp') {
        const off = state.ptp?.offsetNs;
        return off === undefined
            ? undefined
            : Math.min(UINT32_MAX, Math.ceil(Math.abs(off) / 1000));
    }
    const est = state.estErrorUs;
    if (!Number.isFinite(est) || est < 0 || est === KERNEL_ESTERROR_UNSET_US) return undefined;
    return Math.min(UINT32_MAX, Math.ceil(est));
}

/** The fields from the epoch and the state; `env` is read for the test override only. */
export function houseClockFields(
    epoch: HouseEpoch | null,
    state: TimeSyncState | null,
    env: NodeJS.ProcessEnv = process.env,
): HouseClockFields {
    const source: HouseClockSource = !state
        ? 'none'
        : state.ntpFallback || state.source === 'chrony'
          ? 'ntp'
          : state.source;
    const ptp = source === 'ptp' ? state?.ptp : undefined;
    const err = state ? errorUs(state, source) : undefined;
    const override = overrideENs(env);
    return {
        eNs: override ?? epoch?.eNs ?? 0n,
        seq: epoch?.seq ?? 0,
        traceable: state?.traceable ?? false,
        disciplined: !!state && state.synced && state.source !== 'none',
        source,
        ...(err !== undefined ? { errorUs: err } : {}),
        taiOffsetS: state?.taiOffsetS ?? 0,
        ptpDomain: ptp?.domain ?? -1,
        gm: ptp?.gmIdentity ?? '',
        ...(override !== undefined ? { eOverridden: true } : {}),
    };
}

/** hcdesc::error_class: ceil(log2(max(1, µs))) up to 31; 0xFF unknown. */
export function houseClockErrorClass(errorUs: number | undefined): number {
    if (errorUs === undefined || !(errorUs >= 0)) return 0xff;
    let cls = 0;
    while (cls < 31 && 2 ** cls < errorUs) cls++;
    return cls;
}

/** What a writer's descriptor would change on, the error by class: equal keys push nothing. */
export function houseClockKey(f: HouseClockFields): string {
    return [
        f.eNs,
        f.seq,
        f.traceable,
        f.disciplined,
        f.source,
        houseClockErrorClass(f.errorUs),
        f.taiOffsetS,
        f.ptpDomain,
        f.gm,
    ].join('|');
}

/** The serialised GstStructure; `error-us` is left out when unknown. */
export function houseClockFieldsString(f: HouseClockFields): string {
    if (f.eOverridden)
        log.warn(
            `clock: house-clock E = ${f.eNs} ns from ${HOUSE_CLOCK_E_OVERRIDE_ENV} (test only)`,
        );
    const parts = [
        'house-clock',
        `e-ns=(gint64)${f.eNs}`,
        `seq=(uint)${f.seq}`,
        `traceable=(boolean)${f.traceable}`,
        `disciplined=(boolean)${f.disciplined}`,
        `source=(string)${f.source}`,
        ...(f.errorUs !== undefined ? [`error-us=(uint)${f.errorUs}`] : []),
        `tai-offset-s=(int)${f.taiOffsetS}`,
        `ptp-domain=(int)${f.ptpDomain}`,
        `gm=(string)"${f.gm}"`,
    ];
    return parts.join(', ');
}

/** `house-clock`'s value for this epoch and state (plan ch. 9 part 4.6). */
export function houseClockGstString(
    epoch: HouseEpoch | null,
    state: TimeSyncState | null,
    env: NodeJS.ProcessEnv = process.env,
): string {
    return houseClockFieldsString(houseClockFields(epoch, state, env));
}

/** `house-clock=<value>` for a pipeline string, quoted with quoteGstString. */
export function houseClockPipelineProperty(value: string): string {
    return `house-clock=${quoteGstString(value)}`;
}
