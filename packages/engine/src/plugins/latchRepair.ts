/**
 * Latch repair — whether a producer's egress stamper may repair a late first
 * PES (ADR-0005 decision 2, note 2026-09-05; the arithmetic is
 * `ts_timeline.py` / `mrts::TimelineStamper`, "latch repair").
 *
 * The repair rests on ONE assumption: that the producer's delivery cadence is
 * its media cadence, so a buffer that arrives before its stamp proves the
 * anchor late. That is a property of the SOURCE at the head of the chain, not
 * of the producer: a splitter riding an srt-input delivers at the source's
 * cadence, and so does a muxer riding that splitter — but a splitter riding an
 * hls-player inherits the player's per-segment burst and its deliberate 2 s
 * lead, and repairing onto THAT would stamp the head of every later segment
 * late by a segment (the 2026-08-13 position-loop failure in a new coat). So
 * the decision is resolved here, once, from the graph — the same shape as the
 * playout offset D (`playoutOffset.ts`), which is also a route-head property
 * every leg has to agree on — and handed to the runner / mr-tssplit as a flag
 * instead of being hard-coded ON in each producer.
 *
 * The engine names no plugin (ADR-0007): a producer whose delivery runs ahead
 * of real time says so itself through `PluginModule.isDeliveryLeadProducer`,
 * and the router reports that declaration for every upstream producer.
 */

/** The route-lookup surface `effectiveLatchRepair` needs from `MediaRouter`. */
export interface LatchRepairRouteSource {
    /** Every bus producer upstream of `moduleId`, transitively, with its declaration. */
    getUpstreamBusProducers(moduleId: string): Array<{ pluginId: string; deliveryLead: boolean }>;
}

/** The slice of `ModuleServices` the resolution reads. */
export interface LatchRepairServices {
    instanceId?: string;
    mediaRouter?: Partial<LatchRepairRouteSource>;
}

/**
 * True when this producer's stamper may run the latch-repair window: no
 * delivery-lead producer anywhere upstream of it. A module with no bus input
 * (a network ingest, a capture) has no upstream and repairs; a harness without
 * a router resolves to the live default.
 */
export function effectiveLatchRepair(services: LatchRepairServices | null | undefined): boolean {
    const upstream = services?.instanceId
        ? (services.mediaRouter?.getUpstreamBusProducers?.(services.instanceId) ?? [])
        : [];
    return !upstream.some((producer) => producer.deliveryLead);
}
