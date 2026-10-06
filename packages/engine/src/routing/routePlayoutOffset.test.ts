import { describe, it, expect } from 'vitest';
import { downstreamBusConsumers, resolveRoutePlayoutOffsetMs } from './routePlayoutOffset.js';

/**
 * The walks behind ADR-0005 decision 4 (amended 2026-10-04), on bare edges.
 * `ROUTE` is BCC Mulanje's Translation Station (10.37.7.24): srt-input →
 * ts-splitter → { video-player, audio-decoder, audio-transcoder → 302M
 * output }. The 302M leg's direct source is the transcoder, which declares no
 * D — the walk is what lets the route's one number reach it.
 */
type Edge = [source: string, sink: string, sinkPort?: string];

const ROUTE: Edge[] = [
    ['srt', 'splitter'],
    ['splitter', 'video', 'mpegts-in'],
    ['splitter', 'decoder'],
    ['splitter', 'transcoder'],
    ['transcoder', 'out302m', 'audio-in'],
];

/** First edge into `id` (on `port`, when given) — `getModuleBusSource`'s rule. */
const sourceOf = (edges: Edge[]) => (id: string, port?: string) =>
    edges.find(([, sink, p]) => sink === id && (port === undefined || p === port))?.[0];
const consumersOf = (edges: Edge[]) => (id: string) =>
    edges.filter(([source]) => source === id).map(([, sink]) => sink);

function resolve(
    configs: Record<string, Record<string, unknown>>,
    id: string,
    port?: string,
    edges = ROUTE,
) {
    return resolveRoutePlayoutOffsetMs(sourceOf(edges), (m) => configs[m], id, port);
}

describe('resolveRoutePlayoutOffsetMs', () => {
    it('gives the 302M leg behind the transcoder the same D as its sibling legs', () => {
        const cfg = { splitter: { playoutOffsetMs: 260 } };
        expect(resolve(cfg, 'video')).toBe(260);
        expect(resolve(cfg, 'decoder')).toBe(260);
        expect(resolve(cfg, 'out302m')).toBe(260);
    });

    it('the nearest producer that SETS one wins', () => {
        const cfg = {
            srt: { playoutOffsetMs: 500 },
            splitter: { playoutOffsetMs: 260 },
            transcoder: { playoutOffsetMs: 120 },
        };
        expect(resolve(cfg, 'out302m')).toBe(120);
        expect(resolve(cfg, 'decoder')).toBe(260);
    });

    it('takes 0 as a deliberate value rather than walking past it', () => {
        const cfg = { srt: { playoutOffsetMs: 500 }, splitter: { playoutOffsetMs: 0 } };
        expect(resolve(cfg, 'out302m')).toBe(0);
    });

    it('walks through an unset or nonsense splitter to the ingest — the deliberate change', () => {
        expect(resolve({ srt: { playoutOffsetMs: 500 } }, 'decoder')).toBe(500);
        const nonsense = { srt: { playoutOffsetMs: 500 }, splitter: { playoutOffsetMs: 'soon' } };
        expect(resolve(nonsense, 'out302m')).toBe(500);
    });

    it('is undefined when nothing upstream sets one, and for a module with no input', () => {
        expect(resolve({}, 'out302m')).toBeUndefined();
        expect(resolve({ srt: { playoutOffsetMs: 500 } }, 'srt')).toBeUndefined();
    });

    it('narrows only the FIRST hop by sink port', () => {
        const edges: Edge[] = [...ROUTE, ['subs', 'video', 'subtitles-in']];
        const cfg = { splitter: { playoutOffsetMs: 240 }, subs: { playoutOffsetMs: 900 } };
        expect(resolve(cfg, 'video', 'mpegts-in', edges)).toBe(240);
        expect(resolve(cfg, 'video', 'subtitles-in', edges)).toBe(900);
        // Past the first hop the port no longer narrows: the splitter has no
        // 'mpegts-in' edge, yet the walk still reaches the srt-input.
        expect(resolve({ srt: { playoutOffsetMs: 500 } }, 'video', 'mpegts-in', edges)).toBe(500);
    });

    it('terminates on a cycle', () => {
        const loop: Edge[] = [
            ['a', 'b'],
            ['b', 'a'],
        ];
        expect(resolve({}, 'a', undefined, loop)).toBeUndefined();
    });
});

describe('downstreamBusConsumers', () => {
    it('reaches every leg below a head, nearest first, once each', () => {
        expect(downstreamBusConsumers(consumersOf(ROUTE), 'splitter')).toEqual([
            'video',
            'decoder',
            'transcoder',
            'out302m',
        ]);
        expect(downstreamBusConsumers(consumersOf(ROUTE), 'transcoder')).toEqual(['out302m']);
        expect(downstreamBusConsumers(consumersOf(ROUTE), 'out302m')).toEqual([]);
    });

    it('reports a diamond once and survives a cycle', () => {
        const diamond: Edge[] = [
            ['h', 'a'],
            ['h', 'b'],
            ['a', 'm'],
            ['b', 'm'],
            ['m', 'h'],
        ];
        expect(downstreamBusConsumers(consumersOf(diamond), 'h')).toEqual(['a', 'b', 'm']);
    });
});
