/**
 * Muxer PID SLOT LAYOUT and conflict detection. Pure — no GStreamer / engine
 * runtime. Which output PID each input is pinned to (ADR-0017 as amended
 * 2026-09-18: one PID per generic input; legacy ports on the old per-kind
 * class ranges), and why a layout may be refused (`MuxerPidConflictError`).
 */

import {
    muxSlotPid,
    nextFreeInputPid,
    MUX_SLOTS_PER_CLASS,
    RESERVED_PIDS,
    type MuxRouteMedia,
} from './muxPids.js';
import { legacyPortMedia, portIndex, type InputEntry, type UdpInputSource } from './muxerInputs.js';

/**
 * One output PID slot: the input (sink port + demux branch) that fills it
 * and the PID it is pinned to. A GENERIC input has exactly one slot — its
 * stream's PID — with no `media`: which class lands there (and where any
 * further class of a multi-stream source goes) is the runner hook's call
 * from the source PMT, reported back on `mux:routed`. A LEGACY port has one
 * slot per class it routes, each on a fixed class-range PID.
 */
export interface MuxedStreamSlot {
    sinkPortId: string;
    /** `demux_<i>` element name of this slot's input branch. */
    demux: string;
    /** Legacy ports only; absent on a generic input's slot. */
    media?: MuxRouteMedia;
    pid: number;
    /** False when the PID comes from an operator-set value (InputEntry.pid). */
    automatic: boolean;
}

/**
 * Slot layout for the given (already sorted) sources.
 *
 * Generic `input-N`: ONE slot on the operator's `pid`, or — for a source
 * that arrives without one (the module normally seeds every entry first) —
 * the next free automatic PID, skipping every set PID and every automatic
 * one handed out earlier in the list.
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
    const taken = new Set(sources.flatMap((s) => (s.pid !== undefined ? [s.pid] : [])));
    sources.forEach((source, i) => {
        const demux = `demux_${i}`;
        const legacy = legacyPortMedia(source.sinkPortId);
        const push = (pid: number, automatic: boolean, media?: MuxRouteMedia) => {
            slots.push({
                sinkPortId: source.sinkPortId,
                demux,
                ...(media ? { media } : {}),
                pid,
                automatic,
            });
        };
        // Legacy per-class ranges (see layoutSlots doc); no slot when the
        // ordinal runs past the range.
        const legacySlot = (media: MuxRouteMedia, index: number) => {
            if (index < MUX_SLOTS_PER_CLASS) push(muxSlotPid(media, index), true, media);
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
        if (source.pid !== undefined) {
            push(source.pid, false);
            return;
        }
        const pid = nextFreeInputPid(taken);
        taken.add(pid);
        push(pid, true);
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
    return `${slot.sinkPortId}${slot.media ? ` ${slot.media}` : ''}${slot.automatic ? ' (automatic)' : ''}`;
}

/**
 * Every PID clash in a slot layout, as operator-facing sentences. Two slots on
 * one PID is a clash whether the PIDs were set or automatic (an override that
 * lands on another input's automatic PID is the common mistake); a set PID on
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
