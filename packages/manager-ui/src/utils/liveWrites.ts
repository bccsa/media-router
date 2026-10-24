import * as shared from '@media-router/shared-types';

const { diffValues } = shared;

/** One setting of one module on one engine: where a live write goes. */
export interface LiveTarget {
    engineId: string;
    moduleId: string;
    key: string;
}

type Send = (target: LiveTarget, value: unknown) => void;

const idOf = (t: LiveTarget) => JSON.stringify([t.engineId, t.moduleId, t.key]);

/** A target's throttle window: the value its first edge sent, and the latest held since. */
interface ThrottleWindow {
    target: LiveTarget;
    timer: ReturnType<typeof setTimeout>;
    sent: unknown;
    held?: { value: unknown };
}

/**
 * Live setting writes held back by a throttle (the first at once, then the latest each window) or a
 * debounce (once the value rests). Each held value keeps the target it was made on and goes there,
 * whatever the caller shows by then (B-106).
 */
export function createLiveWrites(send: Send, throttleMs: number) {
    const throttles = new Map<string, ThrottleWindow>();
    const debounces = new Map<
        string,
        { target: LiveTarget; timer: ReturnType<typeof setTimeout>; value: unknown }
    >();

    // The value the window opened with is written already: moved back to it, nothing goes (B-108).
    function sendHeld(w: ThrottleWindow): void {
        if (w.held && diffValues(w.sent, w.held.value).length > 0) send(w.target, w.held.value);
    }

    function closeWindow(id: string): void {
        const w = throttles.get(id);
        throttles.delete(id);
        if (w) sendHeld(w);
    }

    return {
        /** At once when its target has no window open, else held: the latest goes when it closes. */
        throttle(target: LiveTarget, value: unknown): void {
            const id = idOf(target);
            const open = throttles.get(id);
            if (open) {
                open.held = { value };
                return;
            }
            send(target, value);
            throttles.set(id, {
                target,
                sent: value,
                timer: setTimeout(() => closeWindow(id), throttleMs),
            });
        },

        /** Sent once its target has had no new value for `ms`. */
        debounce(target: LiveTarget, value: unknown, ms: number): void {
            const id = idOf(target);
            const waiting = debounces.get(id);
            if (waiting) clearTimeout(waiting.timer);
            const timer = setTimeout(() => {
                debounces.delete(id);
                send(target, value);
            }, ms);
            debounces.set(id, { target, timer, value });
        },

        /** Every held value to its own target now, and no window left open. */
        flush(): void {
            for (const w of throttles.values()) {
                clearTimeout(w.timer);
                sendHeld(w);
            }
            throttles.clear();
            for (const d of debounces.values()) {
                clearTimeout(d.timer);
                send(d.target, d.value);
            }
            debounces.clear();
        },
    };
}
