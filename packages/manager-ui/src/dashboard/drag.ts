import { clampNumber } from './valueTypes';

/**
 * Grab-and-drag (ADR-0026): the value moves by how far the pointer travels,
 * from where it was — a touch alone changes nothing. `travel` is in pixels
 * along the control (up or right positive), `length` its usable length.
 */
export function dragValue(start: number, travel: number, length: number, min: number, max: number, step?: number): number {
    const raw = start + (travel / Math.max(1, length)) * (max - min);
    const stepped = step && step > 0 ? min + Math.round((raw - min) / step) * step : raw;
    return clampNumber(stepped, min, max);
}

/** Where `value` sits along `min…max`, 0–1. */
export function fraction(value: number, min: number, max: number): number {
    if (max <= min) return 0;
    return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

/**
 * At most one send per `ms` while moving, the latest value winning, and the
 * final value always sent on release.
 */
export function throttled<T>(send: (v: T) => void, ms = 100) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending: { v: T } | null = null;
    let last: { v: T } | null = null;
    const fire = (v: T) => {
        last = { v };
        send(v);
    };
    return {
        push(v: T) {
            if (!timer) {
                fire(v);
                timer = setTimeout(() => {
                    timer = null;
                    if (pending) fire(pending.v);
                    pending = null;
                }, ms);
            } else pending = { v };
        },
        end(v: T) {
            if (timer) clearTimeout(timer);
            timer = null;
            pending = null;
            if (!last || last.v !== v) fire(v);
            last = null;
        },
    };
}

/**
 * For a value whose every change is costly (`x-debounceMs`, e.g. an encoder's
 * bitrate): sent once the drag rests `ms`, and the final value on release.
 */
export function debounced<T>(send: (v: T) => void, ms: number) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let last: { v: T } | null = null;
    const fire = (v: T) => {
        last = { v };
        send(v);
    };
    return {
        push(v: T) {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                timer = null;
                fire(v);
            }, ms);
        },
        end(v: T) {
            if (timer) clearTimeout(timer);
            timer = null;
            if (!last || last.v !== v) fire(v);
            last = null;
        },
    };
}
