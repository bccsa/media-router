import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { delimiter, join, relative, resolve } from 'node:path';
import { crc32 as zlibCrc32 } from 'node:zlib';

// WI-S0-10: `mrts_cli dump` and hls-pipe's demuxer, two independent parsers, must agree PES for
// PES (pid, pts, dts, payload length and CRC-32) wherever hls-pipe can read. A reference only:
// the .expect.jsonl files stay the truth. A difference outside ALLOWLIST is a finding, so it fails.

const REPO = resolve(__dirname, '../../..');
const NATIVE_DIR = join(__dirname, '../native');
const CLI = join(NATIVE_DIR, 'mrts/mrts_cli');
// HLS_PIPE_DIR: another checkout, for a worktree whose submodule is not checked out.
const HLS_PIPE = process.env.HLS_PIPE_DIR ?? join(REPO, 'packages/hls-pipe');
const DEMUXER = join(HLS_PIPE, 'src/demux/demuxer.ts');

const tsFiles = (dir: string): string[] =>
    existsSync(dir)
        ? readdirSync(dir)
              .filter((f) => f.endsWith('.ts'))
              .sort()
              .map((f) => join(dir, f))
        : [];
// WI-S0-9's set, hls-pipe's own, the in-repo real capture (MPEG audio), and captures named in
// HLS_PIPE_REFERENCE_FIXTURES (a path list) to check one before it joins the set.
const FIXTURES = [
    ...tsFiles(join(__dirname, 'fixtures')),
    ...tsFiles(join(HLS_PIPE, 'tests/fixtures')),
    ...[join(REPO, 'v1/output.ts')].filter((f) => existsSync(f)),
    ...(process.env.HLS_PIPE_REFERENCE_FIXTURES ?? '').split(delimiter).filter(Boolean),
];

/** What hls-pipe (src/demux at the pinned commit) does differently, each with the reason. */
const ALLOWLIST = {
    'clamps-pts-dts':
        'hls-pipe sets PTS = DTS when PTS - DTS > 60 s (the hls.js encoder-bug guard in pes.ts); the dump reports the header as written',
    'ignores-cc':
        'hls-pipe ignores continuity: across a CC loss or a discontinuity_indicator it emits the cut or merged PES that the dump drops (a seq gap, the next PES discont), and it keeps both copies of a packet sent twice',
    'single-section-psi':
        'hls-pipe parses a PAT or PMT from one TS packet and re-reads continuation packets as new tables, so a PMT longer than a packet gives it a garbage stream map or a PmtParseError',
    'one-pid-per-kind':
        'hls-pipe follows only the first video, first audio and first ID3 PID of the PMT (pat-pmt.ts); the dump follows every PID',
    'ignores-pes-length':
        'hls-pipe never reads PES_packet_length: a bounded PES cut short, by the next PUSI or by the end of the input (an HLS segment is self-contained), comes back as it is where the dump drops it as malformed, and bytes past the length stay where the dump cuts them',
    'no-resync':
        'hls-pipe finds the packet grid once per segment (hls.js syncOffset) and steps 188 bytes from there, so after garbage that is not whole packets it reads nothing until a step lands on the grid again; the dump resyncs at once',
    'refuses-ec3':
        'hls-pipe throws PmtParseError on a PMT that lists E-AC-3 as stream type 0x87 (pat-pmt.ts parsePMT), so it demuxes nothing of that stream; the dump reads it',
} as const;
type Entry = keyof typeof ALLOWLIST;

interface DumpPmt {
    psi: 'pmt';
    programInfo: string;
    streams: Array<{ pid: number; type: number; esInfo: string }>;
}
interface DumpUnit {
    pid: number;
    pts: number | null;
    dts: number | null;
    len: number;
    crc32: string;
    discont: boolean;
    seq: number;
}
interface DumpCounters {
    desyncBytes: number;
    ccLost: number;
    pesDroppedCc: number;
    pesMalformed: number;
}
// The part of hls-pipe's API used here (DemuxResult, PesPacket in src/demux).
interface HlsPes {
    data: Uint8Array;
    pts: number | undefined;
    dts: number | undefined;
    declaredPayloadLength: number;
    ptsDtsSkewClamped: boolean;
}
type Kind = 'video' | 'audio' | 'metadata';
type HlsResult = Record<Kind, HlsPes[]> & {
    streams: { videoPid: number; audioPid: number; id3Pid: number };
    malformedPackets: number;
};
type Demuxer = new () => { demux(data: Uint8Array): HlsResult };

/** One PES as compared; `unit` is the dump's line, `hls` hls-pipe's packet. */
interface Pes {
    pts: number | null;
    dts: number | null;
    len: number;
    crc: string;
    unit?: DumpUnit;
    hls?: HlsPes;
}
/** A run where the two disagree, between PES both agree on (`next`, `nextHls` the pair after). */
interface Hunk {
    dump: Pes[];
    hls: Pes[];
    prev?: DumpUnit;
    next?: DumpUnit;
    nextHls?: Pes;
}
/** What a hunk is judged against: the dump's counters and hls-pipe's misaligned-packet count. */
interface Facts {
    counters: DumpCounters;
    malformed: number;
}

// zlib's CRC-32, the one the dump prints.
const crcHex = (b: Uint8Array) => zlibCrc32(b).toString(16).padStart(8, '0');

// hls-pipe's PesPacket gives a PTS-only header its PTS as the DTS; the dump prints null.
const fromDump = (u: DumpUnit): Pes => ({
    pts: u.pts,
    dts: u.dts ?? u.pts,
    len: u.len,
    crc: u.crc32,
    unit: u,
});
const fromHls = (p: HlsPes): Pes => ({
    pts: p.pts ?? null,
    dts: p.dts ?? null,
    len: p.data.byteLength,
    crc: crcHex(p.data),
    hls: p,
});
const sameHeader = (a: Pes, b: Pes) => a.pts === b.pts && a.dts === b.dts;
const same = (a: Pes, b: Pes) => sameHeader(a, b) && a.len === b.len && a.crc === b.crc;

const KINDS: Kind[] = ['video', 'audio', 'metadata'];
const VIDEO_TYPES = [0x1b, 0xdb, 0x24];
const AUDIO_TYPES = [0x0f, 0xcf, 0x03, 0x04, 0x81, 0xc1];

// Descriptor tags of an ES info loop, walked as hls-pipe walks it.
function tags(hex: string): number[] {
    const b = Buffer.from(hex, 'hex');
    const out: number[] = [];
    for (let i = 0; b.length - i > 2; i += 2 + b[i + 1]!) out.push(b[i]!);
    return out;
}

// The PIDs hls-pipe follows (pat-pmt.ts parsePMT): the first stream of each kind.
function followed(pmt: DumpPmt): Record<Kind, number> {
    const pids = { video: -1, audio: -1, metadata: -1 };
    for (const s of pmt.streams) {
        const ac3 = s.type === 0x06 && tags(s.esInfo).includes(0x6a);
        const kind: Kind | undefined = VIDEO_TYPES.includes(s.type)
            ? 'video'
            : AUDIO_TYPES.includes(s.type) || ac3
              ? 'audio'
              : s.type === 0x15
                ? 'metadata'
                : undefined;
        if (kind && pids[kind] < 0) pids[kind] = s.pid;
    }
    return pids;
}

// 12 header bytes, the descriptors, the ES loop and the CRC; one packet holds 183 of them.
const pmtBytes = (p: DumpPmt) =>
    16 + p.programInfo.length / 2 + p.streams.reduce((n, s) => n + 5 + s.esInfo.length / 2, 0);

// In order; a disagreement runs to the nearest pair of PES the two agree on again.
function align(dump: Pes[], hls: Pes[]): { agreed: number; hunks: Hunk[] } {
    const hunks: Hunk[] = [];
    let [i, j, agreed] = [0, 0, 0];
    while (i < dump.length || j < hls.length) {
        if (i < dump.length && j < hls.length && same(dump[i]!, hls[j]!)) {
            [i, j, agreed] = [i + 1, j + 1, agreed + 1];
            continue;
        }
        let [k, l] = [dump.length - i, hls.length - j];
        search: for (let d = 1; d <= 32; d++) {
            for (let a = 0; a <= d; a++) {
                if (i + a < dump.length && j + d - a < hls.length) {
                    if (same(dump[i + a]!, hls[j + d - a]!)) {
                        [k, l] = [a, d - a];
                        break search;
                    }
                }
            }
        }
        const [prev, next, nextHls] = [dump[i - 1]?.unit, dump[i + k]?.unit, hls[j + l]];
        hunks.push({ dump: dump.slice(i, i + k), hls: hls.slice(j, j + l), prev, next, nextHls });
        [i, j] = [i + k, j + l];
    }
    return { agreed, hunks };
}

// The hunk's two PES when it is one on each side; the PES starts the dump dropped inside it
// (seq counts every start).
const pair = (h: Hunk): [Pes, Pes] | [] =>
    h.dump.length === 1 && h.hls.length === 1 ? [h.dump[0]!, h.hls[0]!] : [];
const dropped = (h: Hunk) => (h.next ? h.next.seq - (h.prev?.seq ?? -1) - 1 - h.dump.length : 0);

const clamped = (h: Hunk) => {
    const [d, x] = pair(h);
    return (
        !!d &&
        !!x &&
        x.hls!.ptsDtsSkewClamped &&
        d.pts! - d.dts! > 60 * 90000 &&
        x.pts === d.dts &&
        x.dts === d.dts &&
        x.len === d.len &&
        x.crc === d.crc
    );
};

// A CC loss or reset: each PES the dump kept is in hls-pipe's run with its header, and the
// others are ones the dump began and dropped there.
const lostOrReset = (h: Hunk, c: DumpCounters) =>
    !!h.next?.discont &&
    c.ccLost + c.pesDroppedCc > 0 &&
    h.dump.every((d) => h.hls.some((x) => sameHeader(d, x))) &&
    h.hls.filter((x) => !h.dump.some((d) => sameHeader(d, x))).length <= dropped(h);

// A packet sent twice (ISO 13818-1 2.4.3.3) kept by hls-pipe: cutting one copy out gives the
// dump's payload. Cuts at o and o + 1 are the same bytes while b[o] === b[o + n]: one hash a run.
function keptCopy(x: Pes, d: Pes): boolean {
    const [b, n] = [x.hls!.data, x.len - d.len];
    for (let o = 0; n > 0 && o + 2 * n <= b.length; o++) {
        if (b[o] !== b[o + n] || !b.subarray(o, o + n).every((v, k) => v === b[o + n + k]))
            continue;
        if (crcHex(Buffer.concat([b.subarray(0, o), b.subarray(o + n)])) === d.crc) return true;
        while (o + 2 * n < b.length && b[o] === b[o + n]) o++;
    }
    return false;
}
// A PES start sent twice: hls-pipe returns the first copy's bytes as a PES of their own.
const restarted = (x: Pes, next?: Pes) =>
    !!next &&
    sameHeader(x, next) &&
    x.len < next.len &&
    x.hls!.data.every((v, k) => v === next.hls!.data[k]);
const duplicated = (h: Hunk) =>
    h.dump.every((d) => h.hls.some((x) => sameHeader(d, x) && keptCopy(x, d))) &&
    h.hls.every((x) => h.dump.some((d) => sameHeader(d, x)) || restarted(x, h.nextHls));

// Cut short: the one PES is hls-pipe's, shorter than its length says, and the dump dropped it
// at the end of the input or before its next PES. Past its length: the dump's is its prefix.
const cutShort = (h: Hunk, c: DumpCounters) =>
    !h.dump.length &&
    h.hls.length === 1 &&
    h.hls[0]!.hls!.declaredPayloadLength > h.hls[0]!.len &&
    c.pesMalformed > 0 &&
    (!h.next || (h.next.discont && dropped(h) >= 1));
const pastLength = (h: Hunk) => {
    const [d, x] = pair(h);
    return (
        !!d &&
        !!x &&
        sameHeader(d, x) &&
        x.hls!.declaredPayloadLength === d.len &&
        x.len > d.len &&
        crcHex(x.hls!.data.subarray(0, d.len)) === d.crc
    );
};

// Off the grid, hls-pipe misses the dump's run but for the PES open at the loss, cut or merged,
// which it returns when it lands on the grid again; if it never does, nothing more comes back.
const offGrid = (h: Hunk, f: Facts) =>
    f.malformed > 0 &&
    f.counters.desyncBytes > 0 &&
    !!h.dump[0] &&
    (h.hls.length === 1 ? sameHeader(h.hls[0]!, h.dump[0]) : !h.hls.length && !h.nextHls);

/** Each hunk-level entry's test: the evidence that this difference is that limit. */
const RULES: Array<[Entry, (h: Hunk, f: Facts) => boolean]> = [
    ['clamps-pts-dts', clamped],
    ['ignores-cc', (h, f) => lostOrReset(h, f.counters) || duplicated(h)],
    ['ignores-pes-length', (h, f) => cutShort(h, f.counters) || pastLength(h)],
    ['no-resync', offGrid],
];

interface Report {
    agreed: number;
    allowed: Partial<Record<Entry, number>>;
    unexplained: string[];
    skip?: string;
}

const show = (p: Pes) =>
    `${p.pts}/${p.dts}/${p.len}/${p.crc}` +
    (p.unit ? ` seq ${p.unit.seq}${p.unit.discont ? ' discont' : ''}` : '');

function compare(file: string, Demux: Demuxer): Report {
    const res = spawnSync(CLI, ['dump', file], { encoding: 'utf8', maxBuffer: 1 << 30 });
    expect(res.status, `mrts_cli dump ${file}: ${res.error ?? res.stderr}`).toBe(0);
    const lines = res.stdout
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    const pmts = lines.filter((l) => l.psi === 'pmt') as unknown as DumpPmt[];
    const units = lines.filter((l) => 'pid' in l) as unknown as DumpUnit[];
    const counters = lines[lines.length - 1]!.counters as DumpCounters;

    const r: Report = { agreed: 0, allowed: {}, unexplained: [] };
    const allow = (e: Entry, n = 1) => (r.allowed[e] = (r.allowed[e] ?? 0) + n);
    if (!pmts.length) return { ...r, skip: 'the dump found no PMT' };
    // Before hls-pipe runs: on such a PMT it may throw (the OCC feed's 3-packet PMT does).
    const long = pmts.find((p) => pmtBytes(p) > 183);
    if (long) {
        allow('single-section-psi');
        return { ...r, skip: `single-section-psi: a ${pmtBytes(long)}-byte PMT` };
    }
    if (pmts.some((p) => p.streams.some((st) => st.type === 0x87))) {
        allow('refuses-ec3');
        return { ...r, skip: 'refuses-ec3: an E-AC-3 stream of type 0x87' };
    }
    const bytes = readFileSync(file);
    const out = new Demux().demux(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length));
    const pids = followed(pmts[0]!);
    for (const p of pmts) {
        if (KINDS.some((k) => followed(p)[k] !== pids[k]))
            r.unexplained.push(
                `a PMT change moves hls-pipe's PIDs to ${JSON.stringify(followed(p))}`,
            );
    }
    const s = out.streams;
    const got = { video: s.videoPid, audio: s.audioPid, metadata: s.id3Pid };
    if (KINDS.some((k) => got[k] !== pids[k]))
        r.unexplained.push(
            `hls-pipe followed ${JSON.stringify(got)}, the PMT gives ${JSON.stringify(pids)}`,
        );
    const others = new Set(
        units.map((u) => u.pid).filter((p) => !KINDS.some((k) => pids[k] === p)),
    );
    if (others.size) allow('one-pid-per-kind', others.size);
    if (KINDS.every((k) => pids[k] < 0)) return { ...r, skip: 'no stream hls-pipe reads' };

    const facts: Facts = { counters, malformed: out.malformedPackets };
    for (const kind of KINDS) {
        if (pids[kind] < 0) continue;
        const dump = units.filter((u) => u.pid === pids[kind]).map(fromDump);
        const { agreed, hunks } = align(dump, out[kind].map(fromHls));
        r.agreed += agreed;
        for (const h of hunks) {
            const entry = RULES.find(([, explains]) => explains(h, facts))?.[0];
            if (entry) allow(entry);
            else
                r.unexplained.push(
                    `${kind} pid ${pids[kind]} after seq ${h.prev?.seq ?? '-'}: dump [` +
                        `${h.dump.map(show).join(', ')}], hls-pipe [${h.hls.map(show).join(', ')}]`,
                );
        }
    }
    return r;
}

const haveCompiler =
    spawnSync('make', ['--version']).status === 0 && spawnSync('c++', ['--version']).status === 0;

describe.skipIf(!haveCompiler || !existsSync(DEMUXER))('hls-pipe reference comparison', () => {
    let Demux: Demuxer;
    let compared = 0;

    beforeAll(async () => {
        const build = spawnSync('sh', [join(NATIVE_DIR, 'build-host.sh')], { encoding: 'utf8' });
        expect(build.status, `native build failed: ${build.stderr}`).toBe(0);
        Demux = ((await import(DEMUXER)) as { Demuxer: Demuxer }).Demuxer;
    }, 120_000);

    for (const file of FIXTURES) {
        const name = file.startsWith(REPO) ? relative(REPO, file) : file;
        it(`agrees with mrts_cli dump on ${name}`, (ctx) => {
            const r = compare(file, Demux);
            const allowed = Object.entries(r.allowed).map(([e, n]) => `${e} ${n}`);
            console.info(`${name}: ${r.agreed} PES agree; allowed: ${allowed.join(', ') || '-'}`);
            expect(r.unexplained, `unexplained differences on ${name}`).toEqual([]);
            if (r.skip) ctx.skip(r.skip);
            expect(r.agreed, `nothing agrees on ${name}`).toBeGreaterThan(0);
            compared++;
        });
    }

    // Every fixture skipped would pass vacuously: the comparison has to have run somewhere.
    it('compared at least one fixture', () => {
        expect(compared).toBeGreaterThan(0);
    });
});
