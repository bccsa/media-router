// Test-only helper (not shipped: excluded from the plugin build).

const PACKET = 188;

/** One elementary stream of a PMT; `language` from its ISO 639 descriptor (tag 0x0a). */
export interface TsStream {
    pid: number;
    streamType: number;
    language?: string;
}

export interface TsScan {
    /** The first PMT's elementary streams, in PMT order. */
    streams: TsStream[];
    /** Packets with payload_unit_start per PID: on an elementary PID, its PES starts. */
    unitStarts: Map<number, number>;
}

const pid13 = (b: Uint8Array, i: number): number => ((b[i]! & 0x1f) << 8) | b[i + 1]!;
const len12 = (b: Uint8Array, i: number): number => ((b[i]! & 0x0f) << 8) | b[i + 1]!;

/** Read 188-byte packets: the first PAT's PMT, that PMT's streams, the unit starts per PID.
 *  Each table is read from one packet (true of the small tables these tests carry). */
export function scanTs(ts: Uint8Array): TsScan {
    let pmtPid = -1;
    let streams: TsStream[] | null = null;
    const unitStarts = new Map<number, number>();
    for (let off = 0; off + PACKET <= ts.length; off += PACKET) {
        if (ts[off] !== 0x47) throw new Error(`no sync byte at ${off}`);
        const pusi = (ts[off + 1]! & 0x40) !== 0;
        const pid = pid13(ts, off + 1);
        if (pusi) unitStarts.set(pid, (unitStarts.get(pid) ?? 0) + 1);
        const afc = (ts[off + 3]! >> 4) & 0x3;
        if (!pusi || afc === 0 || afc === 2) continue;
        let p = off + 4 + (afc === 3 ? 1 + ts[off + 4]! : 0);
        p += 1 + ts[p]!; // pointer_field
        const end = p + 3 + len12(ts, p + 1) - 4; // the section, less its CRC
        if (pid === 0 && pmtPid < 0) {
            for (let e = p + 8; e + 4 <= end; e += 4) {
                if (((ts[e]! << 8) | ts[e + 1]!) !== 0) {
                    pmtPid = pid13(ts, e + 2);
                    break;
                }
            }
        } else if (pid === pmtPid && !streams) {
            streams = [];
            for (let e = p + 12 + len12(ts, p + 10); e + 5 <= end; e += 5 + len12(ts, e + 3)) {
                const s: TsStream = { pid: pid13(ts, e + 1), streamType: ts[e]! };
                const dEnd = e + 5 + len12(ts, e + 3);
                for (let d = e + 5; d + 2 <= dEnd; d += 2 + ts[d + 1]!) {
                    if (ts[d] !== 0x0a) continue;
                    s.language = String.fromCharCode(ts[d + 2]!, ts[d + 3]!, ts[d + 4]!);
                }
                streams.push(s);
            }
        }
    }
    return { streams: streams ?? [], unitStarts };
}

/** The packets of `ts` whose PID passes `keep`, in order. */
export function filterPids(ts: Uint8Array, keep: (pid: number) => boolean): Buffer {
    const out: Uint8Array[] = [];
    for (let off = 0; off + PACKET <= ts.length; off += PACKET) {
        if (keep(pid13(ts, off + 1))) out.push(ts.subarray(off, off + PACKET));
    }
    return Buffer.concat(out);
}
