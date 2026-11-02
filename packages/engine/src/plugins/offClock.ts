// Timing off the house clock (B-203). An output window this far off is a fault while it lasts and
// sets the module's health; an egress stamp guard's episode is one log line. Same bound as the
// stamp guard's (mrts::IdentityStamp::AHEAD_MAX_NS) and the backlog shedder's sanity bound.
export const OFF_CLOCK_MS = 10_000;

/** The plugin-event channel of an egress stamp guard's episode: the native runner's (from
 *  `mrtsstamp-off-clock`) and mr-tssplit's, one per episode. */
export const STAMP_OFF_CLOCK_EVENT = 'stamp_off_clock';

/** |ms| as an operator reads it: `4 h 22 min`, `53 min 56 s`, `10.5 s`. */
export function offsetText(ms: number): string {
    const a = Math.abs(ms);
    if (a >= 3_600_000) {
        const min = Math.floor(a / 60_000);
        return `${Math.floor(min / 60)} h ${min % 60} min`;
    }
    if (a >= 60_000) {
        const s = Math.floor(a / 1000);
        return `${Math.floor(s / 60)} min ${s % 60} s`;
    }
    return `${(a / 1000).toFixed(1)} s`;
}

/** A lateness (now − stamp) far off the clock: ahead when negative. */
const direction = (latenessMs: number): string => (latenessMs < 0 ? 'ahead' : 'behind');

/** The health text of an output window `latenessMs` off the clock. */
export function offClockText(latenessMs: number): string {
    return `Output timing off the house clock by ${offsetText(latenessMs)} (${direction(latenessMs)})`;
}

/** The `stamp_off_clock` payload: the egress (tee), the PES's PID (-1: the stamp floor), its house
 *  time − now in ms, and the egress's such events so far. */
export interface StampOffClock {
    tee?: string;
    pid?: number;
    offsetMs?: number;
    count?: number;
}

/** The log line of one episode. */
export function stampOffClockText(p: StampOffClock): string {
    const tee = p.tee ?? '?';
    const offset = Number(p.offsetMs ?? 0);
    const by = `${offsetText(offset)} ${offset > 0 ? 'ahead of' : 'behind'} the house clock`;
    if (p.pid === undefined || p.pid < 0) {
        return `Bus egress ${tee}: its stamp was ${by}, reset to house time`;
    }
    const pid = `0x${Number(p.pid).toString(16)}`;
    return `Bus egress ${tee}: a timing PES on PID ${pid} read ${by}, so it timed nothing (${p.count ?? 1} so far)`;
}
