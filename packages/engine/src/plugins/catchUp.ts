// A launch's catch-up (B-206): the native runner skips what a module's inputs deliver stamped
// before its pipeline first plays (`PipelineDescription.catchUp`) and reports it once per launch.

/** Plugin-event channel (runner `catch_up.h` EVENT). */
export const CATCH_UP_EVENT = 'catch_up';

/** One input that skipped content: the probed element, how much content and in how many buffers. */
export interface CaughtUpInput {
    element: string;
    skippedMs: number;
    buffers: number;
}

/** A `catch_up` payload's inputs; null for anything malformed or empty. */
export function readCatchUp(payload: unknown): CaughtUpInput[] | null {
    const inputs = (payload as { inputs?: unknown } | null)?.inputs;
    if (!Array.isArray(inputs)) return null;
    const out: CaughtUpInput[] = [];
    for (const i of inputs as Array<Record<string, unknown>>) {
        const skippedMs = Number(i?.skippedMs);
        if (typeof i?.element !== 'string' || !Number.isFinite(skippedMs)) continue;
        out.push({ element: i.element, skippedMs, buffers: Number(i.buffers) || 0 });
    }
    return out.length ? out : null;
}

const duration = (ms: number): string =>
    ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;

/** The one INFO line of a catch-up: each input by its label, longest first. */
export function catchUpText(skips: Array<{ label: string; skippedMs: number }>): string {
    const parts = [...skips]
        .sort((a, b) => b.skippedMs - a.skippedMs)
        .map((s) => `${duration(s.skippedMs)} of ${s.label}`);
    return `Caught up at the start: skipped ${parts.join(', ')} from before it played, never played late`;
}
