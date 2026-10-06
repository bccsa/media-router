import { PLAYOUT_OFFSET_KEY, parsePlayoutOffsetMs } from '../plugins/playoutOffset.js';

/**
 * Route resolution for the playout offset D (ADR-0005 decision 4, amended
 * 2026-10-04): pure walks over the bus graph. `MediaRouter` supplies the edges
 * (its one-hop `getModuleBusSource` rule, its live connections) and delegates.
 *
 * A route's D is declared by the NEAREST upstream bus producer whose config
 * SETS a valid `playoutOffsetMs` — 0 is a value. Producers that leave it unset
 * (every re-stamping hop: audio-transcoder, transcoder, mixers, muxer; and an
 * unset splitter) are walked THROUGH along their first bus input, the rule the
 * one-hop lookup always used. One hop was the whole rule until BCC Mulanje
 * (10.37.7.24, 2026-10-04): a 302M headphone behind an audio-transcoder
 * resolved the transcoder, which declares nothing, so it stayed on the 60 ms
 * engine default — an ~80 ms sink budget that discarded 23.7 % of its audio —
 * while a Playout Offset on the splitter moved every other leg of the route.
 */

/**
 * The override for the route feeding `moduleId`, in ms; `undefined` ⇒ the
 * engine default. `sourceOf(id, port)` names the producer feeding `id`;
 * `sinkPortId` narrows the first hop only, later hops take the first bus
 * input. A seen-set stops a cycle.
 */
export function resolveRoutePlayoutOffsetMs(
    sourceOf: (moduleId: string, sinkPortId?: string) => string | undefined,
    configOf: (moduleId: string) => Record<string, unknown> | undefined,
    moduleId: string,
    sinkPortId?: string,
): number | undefined {
    const seen = new Set([moduleId]);
    let id = sourceOf(moduleId, sinkPortId);
    while (id !== undefined && !seen.has(id)) {
        seen.add(id);
        const ms = parsePlayoutOffsetMs(configOf(id)?.[PLAYOUT_OFFSET_KEY]);
        if (ms !== undefined) return ms;
        id = sourceOf(id);
    }
    return undefined;
}

/**
 * Every bus consumer downstream of `producerId`, transitively, nearest first
 * and once each — the legs that re-push their sink offset when that producer's
 * D moves. A module without `onRoutePlayoutOffsetChanged` (a transcoder)
 * ignores the call; one whose nearer head sets its own D re-pushes the value
 * it already runs.
 */
export function downstreamBusConsumers(
    consumersOf: (producerId: string) => string[],
    producerId: string,
): string[] {
    const order = [producerId];
    const seen = new Set(order);
    for (let i = 0; i < order.length; i++) {
        for (const id of consumersOf(order[i])) {
            if (seen.has(id)) continue;
            seen.add(id);
            order.push(id);
        }
    }
    return order.slice(1);
}
