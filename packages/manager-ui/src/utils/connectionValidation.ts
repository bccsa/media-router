import { streamTypesCompatible } from '@media-router/shared-types';
import type { PortInfo, ConnectionState } from '@/stores/engines';

export type ValidationResult = { ok: true } | { ok: false; reason: string };

export interface CandidateEnd {
    moduleId: string;
    port: PortInfo;
}

/**
 * Pure connection validator behind the routing editor's drag validation AND
 * the reject toast. Every rule returns a human-readable reason — a silent
 * `false` is a bug (the toast would have nothing to say). Mirrors the
 * engine's `MediaRouter.createConnection` checks; the shared rule
 * (`streamTypesCompatible`) comes from shared-types so both sides can never
 * drift. Ends are as-dragged (Vue Flow lets users drag from either side) —
 * orientation is resolved here, not by the caller.
 */
export function validateCandidateConnection(
    src: CandidateEnd,
    tgt: CandidateEnd,
    connections: readonly ConnectionState[],
): ValidationResult {
    const { port: srcPort } = src;
    const { port: tgtPort } = tgt;

    const hasOutput = srcPort.direction === 'output' || tgtPort.direction === 'output';
    const hasInput = srcPort.direction === 'input' || tgtPort.direction === 'input';
    if (!hasOutput || !hasInput) return { ok: false, reason: 'Connect an output to an input' };

    // Exact match or TS-family (muxed/mpegts ↔ audio/302m) — same rule the
    // engine's PortRegistry enforces; shared-types is the single source.
    if (!streamTypesCompatible(srcPort.streamType, tgtPort.streamType))
        return {
            ok: false,
            reason: `Stream types incompatible: ${srcPort.streamType} → ${tgtPort.streamType}`,
        };

    // Plugin-declared exact-match accept list — opts an input out of
    // TS-family leniency (mirrors PortRegistry.validateCompatibility).
    const [inEnd, outEnd] = tgtPort.direction === 'input' ? [tgt, src] : [src, tgt];
    const accepts = inEnd.port.acceptsStreamTypes;
    if (accepts && !accepts.includes(outEnd.port.streamType))
        return {
            ok: false,
            reason: `"${inEnd.port.label}" accepts only ${accepts.join(', ')} — this source is ${outEnd.port.streamType}`,
        };

    for (const end of [src, tgt]) {
        const max = end.port.maxConnections ?? -1;
        if (max === 0)
            return { ok: false, reason: `Port "${end.port.label}" does not allow connections` };
        if (max > 0) {
            const count = connections.filter(
                (c) =>
                    (c.sourceModuleId === end.moduleId && c.sourcePortId === end.port.id) ||
                    (c.sinkModuleId === end.moduleId && c.sinkPortId === end.port.id),
            ).length;
            if (count >= max)
                return {
                    ok: false,
                    reason: `Port "${end.port.label}" is already at its ${max}-connection limit`,
                };
        }
    }

    return { ok: true };
}
