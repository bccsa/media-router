/**
 * Origin-failure reporting — what hls-pipe's fetch errors mean for the operator.
 *
 * A signed HLS URL carries an expiry. When it lapses mid-event the origin
 * answers 403 and hls-pipe dies with `HTTP 403 for <url>`, the runner
 * crash-restarts, and the card shows a generic "hls-pipe crashed — restarting":
 * three field incidents were spent reading journals to find a cause the box
 * already knew. So the failing text is classified here and turned into a
 * message that names the cause, with the auth case kept distinct from a plain
 * network/origin outage — they need different actions (re-sign the URL vs check
 * the link).
 */

/**
 * Consecutive non-auth fetch failures before we call the stream broken.
 * One is a blip (a dropped segment, a momentary DNS hiccup) and the runner's
 * own restart usually rides it out; three in a row is an outage.
 */
export const FETCH_FAIL_THRESHOLD = 3;

export type OriginFailureKind =
    /** The origin answered, and refused us: 401 / 403. */
    | 'auth'
    /** Anything else that stopped a fetch — other HTTP statuses, network errors. */
    | 'fetch';

export interface OriginFailure {
    kind: OriginFailureKind;
    /** HTTP status, when the text carried one. */
    status?: number;
    /** Short evidence quoted into the message: `HTTP 403`, `fetch failed`. */
    detail: string;
}

/**
 * Network-level failures node's fetch surfaces instead of a status code. Kept
 * to exact markers rather than a loose word match: hls-pipe's normal chatter
 * mentions "network" (the `unstable` ABR preset) and must not read as a fault.
 */
const NETWORK_MARKERS = [
    'fetch failed',
    'ENOTFOUND',
    'ECONNREFUSED',
    'ECONNRESET',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'socket hang up',
];

/**
 * Classify one line of runner output (or a probe error message) as an origin
 * failure. Returns null for everything else — most runner output is progress
 * chatter, and a false positive here would park a red error on a healthy card.
 */
export function classifyOriginFailure(text: string): OriginFailure | null {
    // hls-pipe's loader throws `HTTP <status> for <url>` (NodeLoader.attempt).
    const status = /\bHTTP (\d{3})\b/.exec(text);
    if (status) {
        const code = Number(status[1]);
        const detail = `HTTP ${code}`;
        return code === 401 || code === 403
            ? { kind: 'auth', status: code, detail }
            : { kind: 'fetch', status: code, detail };
    }
    const marker = NETWORK_MARKERS.find((m) => text.includes(m));
    if (marker) return { kind: 'fetch', detail: marker };
    // `timeout <n>ms` is the loader's own per-request deadline.
    const timeout = /\btimeout \d+ms\b/.exec(text);
    if (timeout) return { kind: 'fetch', detail: timeout[0] };
    return null;
}

/**
 * The operator-facing message for a classified failure, or null when it is not
 * worth alarming about yet.
 *
 * Auth is reported on the FIRST occurrence: a 403 is the origin's settled
 * answer, retrying cannot change it, and every second of silence is airtime.
 * Everything else waits for `FETCH_FAIL_THRESHOLD` in a row.
 *
 * @param consecutive Consecutive non-auth fetch failures including this one.
 */
export function originFailureMessage(failure: OriginFailure, consecutive: number): string | null {
    if (failure.kind === 'auth') {
        return failure.status === 401
            ? 'HLS origin rejecting requests (HTTP 401) — credentials missing, rejected or expired'
            : 'HLS origin rejecting requests (HTTP 403) — signed URL likely expired';
    }
    if (consecutive < FETCH_FAIL_THRESHOLD) return null;
    return `HLS fetch failing repeatedly (${consecutive}× ${failure.detail}) — check the URL, origin and network`;
}
