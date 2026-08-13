import { describe, it, expect, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    DEFAULT_PLAYOUT_OFFSET_MS,
    MAX_PLAYOUT_OFFSET_MS,
    effectivePlayoutOffsetMs,
    effectivePlayoutOffsetNs,
    parsePlayoutOffsetMs,
    resolveEnginePlayoutOffsetMs,
    type PlayoutOffsetServices,
} from './playoutOffset.js';

/**
 * Playout offset D — ADR-0005 decision 4.
 *
 * The invariants worth pinning are (a) the resolution ORDER: route head beats
 * engine config beats env beats 300 ms, (b) that the deprecated per-sink trims
 * stack ON TOP rather than replacing anything, and (c) that with the contract
 * off the whole mechanism collapses to the trim alone, which is what the legacy
 * pipelines already emitted.
 */

const route = (overrideMs: number | undefined): PlayoutOffsetServices['mediaRouter'] => ({
    getRoutePlayoutOffsetMs: () => overrideMs,
});

describe('parsePlayoutOffsetMs', () => {
    it('accepts finite numbers in range, from numbers and strings alike', () => {
        expect(parsePlayoutOffsetMs(0)).toBe(0);
        expect(parsePlayoutOffsetMs(450)).toBe(450);
        expect(parsePlayoutOffsetMs('450')).toBe(450);
        expect(parsePlayoutOffsetMs(MAX_PLAYOUT_OFFSET_MS)).toBe(MAX_PLAYOUT_OFFSET_MS);
    });

    it('REJECTS rather than clamps out-of-range and nonsense values', () => {
        // Clamping would silently run a mistyped value as if it had been
        // chosen; rejecting lets the caller fall through to a real default.
        expect(parsePlayoutOffsetMs(-1)).toBeUndefined();
        expect(parsePlayoutOffsetMs(MAX_PLAYOUT_OFFSET_MS + 1)).toBeUndefined();
        expect(parsePlayoutOffsetMs(NaN)).toBeUndefined();
        expect(parsePlayoutOffsetMs(Infinity)).toBeUndefined();
        expect(parsePlayoutOffsetMs('later')).toBeUndefined();
        // `Number('')` is 0 — an empty env var must not read as "0 ms".
        expect(parsePlayoutOffsetMs('')).toBeUndefined();
        expect(parsePlayoutOffsetMs('   ')).toBeUndefined();
        expect(parsePlayoutOffsetMs(undefined)).toBeUndefined();
        expect(parsePlayoutOffsetMs(null)).toBeUndefined();
        expect(parsePlayoutOffsetMs({})).toBeUndefined();
    });
});

describe('resolveEnginePlayoutOffsetMs', () => {
    it('defaults to 300 ms with nothing configured', () => {
        expect(resolveEnginePlayoutOffsetMs(undefined, undefined)).toBe(DEFAULT_PLAYOUT_OFFSET_MS);
        expect(DEFAULT_PLAYOUT_OFFSET_MS).toBe(300);
    });

    it('reads MR_PLAYOUT_OFFSET_MS when the config says nothing', () => {
        expect(resolveEnginePlayoutOffsetMs(undefined, '450')).toBe(450);
        expect(resolveEnginePlayoutOffsetMs(undefined, '0')).toBe(0);
    });

    it('lets an explicit config value win over the env var', () => {
        expect(resolveEnginePlayoutOffsetMs(200, '450')).toBe(200);
        expect(resolveEnginePlayoutOffsetMs(0, '450')).toBe(0);
    });

    it('ignores an unusable env value and falls through to the default', () => {
        for (const bad of ['', 'yes', '-1', '99999']) {
            expect(resolveEnginePlayoutOffsetMs(undefined, bad)).toBe(DEFAULT_PLAYOUT_OFFSET_MS);
        }
    });
});

describe('effectivePlayoutOffsetMs — contract OFF', () => {
    it('is the per-sink trim alone, so legacy pipelines are unchanged', () => {
        expect(effectivePlayoutOffsetMs(null)).toBe(0);
        expect(effectivePlayoutOffsetMs({ instanceId: 'm1' }, { trimMs: 40 })).toBe(40);
    });

    it('never consults the route — off means off', () => {
        const getRoutePlayoutOffsetMs = vi.fn(() => 500);
        effectivePlayoutOffsetMs(
            { instanceId: 'm1', playoutOffsetMs: 300, mediaRouter: { getRoutePlayoutOffsetMs } },
            { trimMs: 40 },
        );
        expect(getRoutePlayoutOffsetMs).not.toHaveBeenCalled();
    });
});

describe('effectivePlayoutOffsetMs — contract ON', () => {
    const base = { instanceId: 'm1', timeSyncContract: true } as const;

    it('uses the engine-wide default when no route override exists', () => {
        expect(
            effectivePlayoutOffsetMs({
                ...base,
                playoutOffsetMs: 300,
                mediaRouter: route(undefined),
            }),
        ).toBe(300);
    });

    it('falls back to 300 ms when the engine reports no default either', () => {
        // Older engines and test harnesses pass no `playoutOffsetMs`; the
        // budget must still be a real number, never 0-by-accident.
        expect(effectivePlayoutOffsetMs(base)).toBe(DEFAULT_PLAYOUT_OFFSET_MS);
    });

    it('lets the route head override WIN over the engine default', () => {
        expect(
            effectivePlayoutOffsetMs({ ...base, playoutOffsetMs: 300, mediaRouter: route(500) }),
        ).toBe(500);
        // Replaces, does not add: 300 + 500 would be the wrong reading.
        expect(
            effectivePlayoutOffsetMs({ ...base, playoutOffsetMs: 300, mediaRouter: route(0) }),
        ).toBe(0);
    });

    it('ignores an out-of-range route override instead of running it', () => {
        expect(
            effectivePlayoutOffsetMs({
                ...base,
                playoutOffsetMs: 300,
                mediaRouter: route(-5),
            }),
        ).toBe(300);
    });

    it('stacks the deprecated per-sink trim on top of D, both signs', () => {
        const services = { ...base, playoutOffsetMs: 300, mediaRouter: route(500) };
        expect(effectivePlayoutOffsetMs(services, { trimMs: 40 })).toBe(540);
        expect(effectivePlayoutOffsetMs(services, { trimMs: -40 })).toBe(460);
    });

    it('resolves the route through the consuming module id and sink port', () => {
        const getRoutePlayoutOffsetMs = vi.fn(() => 500);
        effectivePlayoutOffsetMs(
            { ...base, mediaRouter: { getRoutePlayoutOffsetMs } },
            { sinkPortId: 'mpegts-in' },
        );
        expect(getRoutePlayoutOffsetMs).toHaveBeenCalledWith('m1', 'mpegts-in');
    });

    it('survives a services bag with no router at all (no route ⇒ engine default)', () => {
        expect(effectivePlayoutOffsetMs({ ...base, playoutOffsetMs: 250 })).toBe(250);
    });

    /**
     * The property decision 4 exists for: two consumer legs hanging off ONE
     * route resolve the same D. It holds because both legs run THIS function
     * against the same route, not because two plugins happen to agree — so a
     * per-leg trim is the only way they can differ, and that is deliberate.
     */
    it('gives both legs of one route the same D', () => {
        const shared = { getRoutePlayoutOffsetMs: () => 500 };
        const videoLeg: PlayoutOffsetServices = {
            instanceId: 'video-player-1',
            timeSyncContract: true,
            playoutOffsetMs: 300,
            mediaRouter: shared,
        };
        const audioLeg: PlayoutOffsetServices = {
            instanceId: 'audio-decoder-1',
            timeSyncContract: true,
            playoutOffsetMs: 300,
            mediaRouter: shared,
        };
        expect(effectivePlayoutOffsetMs(videoLeg)).toBe(effectivePlayoutOffsetMs(audioLeg));
        expect(effectivePlayoutOffsetNs(videoLeg)).toBe(effectivePlayoutOffsetNs(audioLeg));
        expect(effectivePlayoutOffsetNs(audioLeg)).toBe(500_000_000);
    });
});

describe('effectivePlayoutOffsetNs', () => {
    it('converts to whole nanoseconds', () => {
        expect(effectivePlayoutOffsetNs({ instanceId: 'm1' }, { trimMs: 40 })).toBe(40_000_000);
        expect(
            effectivePlayoutOffsetNs({ instanceId: 'm1', timeSyncContract: true }, { trimMs: 0.5 }),
        ).toBe(300_500_000);
    });
});

/**
 * Drift guard: the route-head schemas bound `playoutOffsetMs` themselves, and
 * that bound is a COPY of `MAX_PLAYOUT_OFFSET_MS` in four static JSON files.
 * Plugin manifests are hand-written JSON by design (a plugin is discovered, not
 * generated), so nothing makes a copy follow the constant — raise the constant
 * and the GUI silently keeps rejecting at the old ceiling; lower it and the GUI
 * happily accepts a value `parsePlayoutOffsetMs` then throws away, leaving the
 * route on the engine default with no error anywhere. A pinning test is the
 * fix: it costs nothing and it fails on the edit that would have drifted.
 */
describe('plugin schemas ↔ MAX_PLAYOUT_OFFSET_MS', () => {
    const pluginsDir = join(__dirname, '..', '..', '..', '..', 'plugins');

    /** Every `playoutOffsetMs` schema in the tree, wherever it is nested. */
    function findOffsetSchemas(node: unknown, path: string): Array<[string, unknown]> {
        if (!node || typeof node !== 'object') return [];
        const found: Array<[string, unknown]> = [];
        for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
            if (key === 'playoutOffsetMs') found.push([`${path}/${key}`, value]);
            found.push(...findOffsetSchemas(value, `${path}/${key}`));
        }
        return found;
    }

    const schemas = readdirSync(pluginsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .flatMap((e) => {
            let manifest: unknown;
            try {
                manifest = JSON.parse(
                    readFileSync(join(pluginsDir, e.name, 'package.json'), 'utf8'),
                );
            } catch {
                return []; // no manifest (or unreadable) — not a route head
            }
            return findOffsetSchemas(manifest, e.name);
        });

    it('finds the route-head schemas at all (a vacuous pass is not a pass)', () => {
        // If the manifest path or the key name ever moves, this suite must fail
        // loudly rather than quietly guarding nothing.
        expect(schemas.length).toBeGreaterThanOrEqual(4);
    });

    it.each(schemas)('%s bounds the offset at MAX_PLAYOUT_OFFSET_MS', (_path, schema) => {
        expect((schema as { maximum?: number }).maximum).toBe(MAX_PLAYOUT_OFFSET_MS);
    });
});
