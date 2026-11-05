import { busSrcTapName, catchUpText, readCatchUp } from '@media-router/engine';

// B-206: the runner skips, as TS at each bus input's ingress tap, what that input sends stamped
// before this output's launch plays (`catchUp`); the module names each input by its producer.

/** The slice of a bus source this needs. */
export interface CatchUpSource {
    port: number;
    socketPath?: string;
    sourceModuleId?: string;
}

/** The INFO line of one `catch_up` report; null when it names nothing. `name` labels a module. */
export function launchCatchUpText(
    payload: unknown,
    opts: { sources: CatchUpSource[]; name: (moduleId: string) => string },
): string | null {
    // One TS buffer has no span of its own (it carries no duration): nothing worth a line.
    const inputs = readCatchUp(payload)?.filter((i) => i.skippedMs >= 1);
    if (!inputs?.length) return null;
    const label = (element: string): string => {
        const source = opts.sources.find((s) => busSrcTapName(s) === element);
        return source?.sourceModuleId ? opts.name(source.sourceModuleId) : element;
    };
    return catchUpText(inputs.map((i) => ({ label: label(i.element), skippedMs: i.skippedMs })));
}
