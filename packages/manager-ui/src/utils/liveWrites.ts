/** One setting of one module on one engine: where a live write goes. */
export interface LiveTarget {
    engineId: string;
    moduleId: string;
    key: string;
}

type Send = (target: LiveTarget, value: unknown) => void;

const idOf = (t: LiveTarget) => JSON.stringify([t.engineId, t.moduleId, t.key]);

/**
 * Live setting writes held back by a throttle (the first at once, then the latest each window) or a
 * debounce (once the value rests). Each held value keeps the target it was made on and goes there,
 * whatever the caller shows by then (B-106).
 */
export function createLiveWrites(send: Send, throttleMs: number) {
    const throttles = new Map<
        string,
        { target: LiveTarget; timer: ReturnType<typeof setTimeout>; held?: { value: unknown } }
    >();
    const debounces = new Map<
        string,
        { target: LiveTarget; timer: ReturnType<typeof setTimeout>; value: unknown }
    >();

    function closeWindow(id: string): void {
        const t = throttles.get(id);
        throttles.delete(id);
        if (t?.held) send(t.target, t.held.value);
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
            throttles.set(id, { target, timer: setTimeout(() => closeWindow(id), throttleMs) });
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
            for (const t of throttles.values()) {
                clearTimeout(t.timer);
                if (t.held) send(t.target, t.held.value);
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
