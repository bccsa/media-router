/**
 * Muxer PID SLOT LAYOUT and conflict detection. Pure — no GStreamer / engine
 * runtime. Which output PID each route class of each input is pinned to
 * (ADR-0017: generic inputs in 8-PID blocks, legacy ports on the old per-kind
 * ranges), and why a layout may be refused (`MuxerPidConflictError`).
 */

import {
    muxInputBasePid,
    muxInputClassPid,
    muxSlotPid,
    MUX_SLOTS_PER_CLASS,
    TS_METADATA_PID,
    type MuxRouteMedia,
} from './muxPids.js';
import { legacyPortMedia, portIndex, type InputEntry, type UdpInputSource } from './muxerInputs.js';

/** PIDs an override may never take, with the reason shown to the operator.
 *  0x1f0 is the metadata PID older muxers used for their name carousel: every
 *  muxer still drops an upstream 0x1f0 (`ignorePids`), so a block landing on
 *  it would vanish at the next hop. */
const RESERVED_PIDS: ReadonlyArray<[number, string]> = [
    [0x1000, "mpegtsmux's PMT"],
    [TS_METADATA_PID, "the metadata PID older muxers' name carousel used (dropped downstream)"],
];

/** Route classes a generic input carries through. `data` (anything else
 *  tsdemux exposes) is deliberately NOT routed: mpegtsmux has no sink caps
 *  for it, and a failed request-pad link is a pipeline error. */
const ROUTED_MEDIA: readonly MuxRouteMedia[] = ['video', 'audio', 'klv', 'subtitle'];

/**
 * One output PID slot: the input (sink port + demux branch) that may fill it,
 * the route class it takes, and the deterministic PID it is pinned to. The
 * module joins `stream:discovered` events (demux element + the pad's route
 * class) back to slots through this.
 */
export interface MuxedStreamSlot {
    sinkPortId: string;
    /** `demux_<i>` element name of this slot's input branch. */
    demux: string;
    media: MuxRouteMedia;
    pid: number;
    /** False when the PID comes from an operator-set base (InputEntry.pid). */
    automatic: boolean;
}

/**
 * Slot layout for the given (already sorted) sources.
 *
 * Generic `input-N`: one 8-PID block per input — the operator's `pid` or the
 * automatic `muxInputBasePid(N)` (N is the PORT index, so a slot keeps its PID
 * whatever else is (dis)connected) — with each class at its fixed offset
 * (`muxInputClassPid`: video +0, audio +1, klv +2, subtitle +3).
 *
 * Legacy `video-N` / `audio-N`: the port's own kind at the OLD scheme — the
 * connected-source ordinal within that kind (video 0x100+, audio 0x140+),
 * byte-for-byte what the port produced before generic inputs — plus klv and
 * subtitle slots keyed by the source's overall ordinal so they cannot collide
 * across ports. A legacy port never routes the other A/V kind (it never did,
 * and its ordinal-based PID could collide with a sibling port's).
 */
export function layoutSlots(sources: UdpInputSource[]): MuxedStreamSlot[] {
    const slots: MuxedStreamSlot[] = [];
    let videoOrdinal = 0;
    let audioOrdinal = 0;
    sources.forEach((source, i) => {
        const demux = `demux_${i}`;
        const legacy = legacyPortMedia(source.sinkPortId);
        const push = (media: MuxRouteMedia, pid: number, automatic: boolean) => {
            slots.push({ sinkPortId: source.sinkPortId, demux, media, pid, automatic });
        };
        // Legacy per-class ranges (see layoutSlots doc); no slot when the
        // ordinal runs past the range.
        const legacySlot = (media: MuxRouteMedia, index: number) => {
            if (index < MUX_SLOTS_PER_CLASS) push(media, muxSlotPid(media, index), true);
        };
        if (legacy === 'video') {
            legacySlot('video', videoOrdinal++);
            legacySlot('klv', i);
            legacySlot('subtitle', i);
            return;
        }
        if (legacy === 'audio') {
            legacySlot('audio', audioOrdinal++);
            legacySlot('klv', i);
            legacySlot('subtitle', i);
            return;
        }
        // Generic: one block per input — the operator's base PID or the
        // automatic block for the PORT index, so a slot keeps its PID whatever
        // else is (dis)connected.
        const n = portIndex(source.sinkPortId) ?? i;
        const base = source.pid ?? (n < MUX_SLOTS_PER_CLASS ? muxInputBasePid(n) : undefined);
        if (base === undefined) return;
        for (const media of ROUTED_MEDIA) {
            push(media, muxInputClassPid(base, media), source.pid === undefined);
        }
    });
    return slots;
}

/** Thrown by `buildPipeline` when two slots would request the same mpegtsmux
 *  PID, or an override takes a reserved one. `conflicts` is operator prose. */
export class MuxerPidConflictError extends Error {
    constructor(public readonly conflicts: string[]) {
        super(`PID conflict — ${conflicts.join('; ')}`);
        this.name = 'MuxerPidConflictError';
    }
}

function describeSlot(slot: MuxedStreamSlot): string {
    return `${slot.sinkPortId} ${slot.media}${slot.automatic ? ' (automatic)' : ''}`;
}

/**
 * Every PID clash in a slot layout, as operator-facing sentences. Two slots on
 * one PID is a clash whether the PIDs were set or automatic (an override that
 * lands on another input's automatic slot is the common mistake); a set PID on
 * a reserved value is one too. Automatic slots never clash with each other by
 * construction, so an empty result is the normal case.
 */
export function findPidConflicts(slots: MuxedStreamSlot[]): string[] {
    const conflicts: string[] = [];
    const byPid = new Map<number, MuxedStreamSlot[]>();
    for (const slot of slots) byPid.set(slot.pid, [...(byPid.get(slot.pid) ?? []), slot]);
    for (const [pid, group] of [...byPid.entries()].sort((a, b) => a[0] - b[0])) {
        const hex = `0x${pid.toString(16)}`;
        const reserved = RESERVED_PIDS.find(([r]) => r === pid);
        if (reserved && group.some((s) => !s.automatic)) {
            conflicts.push(`PID ${hex} is ${reserved[1]} — ${group.map(describeSlot).join(', ')}`);
            continue;
        }
        if (group.length > 1) {
            conflicts.push(`PID ${hex} is set on ${group.map(describeSlot).join(' and ')}`);
        }
    }
    return conflicts;
}

/**
 * Config-level PID check: lay out EVERY configured input as if wired, so a
 * clash is reported the moment it is configured, not when the second input
 * happens to connect. Legacy lists are laid out in their port order.
 */
export function configPidConflicts(entries: InputEntry[]): string[] {
    const sources: UdpInputSource[] = entries.map((e, i) => ({
        sinkPortId: e.id,
        port: i,
        ...(e.pid !== undefined ? { pid: e.pid } : {}),
    }));
    return findPidConflicts(layoutSlots(sortSources(sources)));
}

/** Sort a list of input sources so the resulting pipeline is deterministic:
 *  by port-id prefix, then by port NUMBER (`input-2` before `input-10` — a
 *  plain string sort would not, and demux/branch numbering follows this
 *  order). Legacy ids sort `audio-*` before `video-*` exactly as before. */
export function sortSources(sources: UdpInputSource[]): UdpInputSource[] {
    const key = (id: string): [string, number] => {
        const n = portIndex(id);
        return n === undefined ? [id, -1] : [id.slice(0, id.lastIndexOf('-')), n];
    };
    return [...sources].sort((a, b) => {
        const [pa, na] = key(a.sinkPortId);
        const [pb, nb] = key(b.sinkPortId);
        return pa.localeCompare(pb) || na - nb;
    });
}
