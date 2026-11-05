import { describe, it, expect, afterEach } from 'vitest';
import type { PatchOp } from '@media-router/shared-types';
import { managerRig, sleep } from './testing/managerRig.js';
import { repoPlugin } from './testing/routerRig.js';

/**
 * A reconnect leaves alone the defaults a module start filled into the engine's own config, which
 * the manager never stored (MR-035, B-212). The engine's module manager over stand-in plugins.
 */
const set = (path: string, value: unknown): PatchOp => ({ op: 'replace', path, value });
const PLUGINS = Object.fromEntries(
    ['srt-input', 'srt-output', 'mpegts-muxer', 'rist-input'].map((id) => [id, repoPlugin(id)]),
);
const mod = (pluginId: string, displayName: string, settings: Record<string, unknown>) => ({
    pluginId,
    displayName,
    enabled: true,
    settings,
});
/** As an older manager stored them: none of the house-clock keys, few of the others. */
const MODULES = {
    in1: mod('srt-input', 'SRT In', { port: 9000, mode: 'listener' }),
    out1: mod('srt-output', 'SRT Out', { host: '198.51.100.7', port: 9100, mode: 'caller' }),
    mux1: mod('mpegts-muxer', 'Muxer', {}),
    // A link without the item defaults (weight, cname): the start fills those in too.
    rist1: mod('rist-input', 'RIST In', {
        links: [{ mode: 'listener', address: '0.0.0.0', port: 5004 }],
    }),
};
const IDS = Object.keys(MODULES);
/** Let the patch router's 100 ms throttle hand a write on. */
const flush = () => sleep(150);

let rig: Awaited<ReturnType<typeof managerRig>> | null = null;
afterEach(async () => {
    await rig?.close();
    rig = null;
});

describe('a reconnect and the defaults a module start filled in (MR-035)', () => {
    it('no op for them, no restart pending, the modules run on with them; real changes still go through', async () => {
        const r = (rig = await managerRig({ modules: MODULES, plugins: PLUGINS }));
        await r.startModules();
        // The starts filled the defaults into the engine's own config; the manager never had them.
        expect(r.config().modules.in1.settings).toMatchObject({
            ingestOffsetMs: 0,
            pidTrimsMs: {},
            smoothingCooldownMin: 5,
            latency: 125,
        });
        expect(r.config().modules.out1.settings).toMatchObject({ packetsPerDatagram: 0 });
        expect(r.config().modules.mux1.settings).toMatchObject({
            inputs: [{ name: '', language: '' }],
            videoParserBypass: false,
        });
        expect(r.config().modules.rist1.settings.links).toEqual([
            { mode: 'listener', address: '0.0.0.0', port: 5004, weight: 50, cname: '' },
        ]);
        expect(r.stored().modules.in1.settings).toEqual({ port: 9000, mode: 'listener' });
        /** The settings each plugin runs with. */
        const running = () =>
            Object.fromEntries(IDS.map((id) => [id, structuredClone(r.plugin(id).config)]));
        const pending = () =>
            Object.fromEntries(IDS.map((id) => [id, r.module(id).getState().pendingRestart]));
        const ran = running();
        const shown = await Promise.all(IDS.map((id) => r.routerRead(`/modules/${id}/settings`)));
        const [routerMark, lcpMark] = [r.routerSeen.length, r.lcpOps.length];

        // A full outage and the real reconnect, nothing changed meanwhile.
        await r.outage();
        await sleep(300);
        expect(r.fromManager).toEqual([]);
        expect(pending()).toEqual({ in1: false, out1: false, mux1: false, rist1: false });
        expect(running()).toEqual(ran);
        // The router tree (its dashboards) and the LCP show them as before.
        expect(await Promise.all(IDS.map((id) => r.routerRead(`/modules/${id}/settings`)))).toEqual(
            shown,
        );
        expect(shown[0]).toMatchObject({
            ingestOffsetMs: 0,
            pidTrimsMs: {},
            smoothingCooldownMin: 5,
        });
        expect(
            r.routerSeen.slice(routerMark).filter((op) => op.path.includes('/settings')),
        ).toEqual([]);
        expect(r.lcpOps.slice(lcpMark)).toEqual([]);

        // Another outage: the manager changes a live and a restart-needing setting, the box its own.
        await r.outage(async () => {
            await r.managerWrite([
                set('/modules/in1/settings/ingestOffsetMs', 120),
                set('/modules/out1/settings/latency', 200),
            ]);
            await r.routerWrite([set('/modules/in1/settings/playoutOffsetMs', 300)]);
            await flush();
        });
        await sleep(300);
        expect(r.fromManager).toEqual([
            [
                set('/modules/in1/settings/ingestOffsetMs', 120),
                set('/modules/out1/settings/latency', 200),
            ],
        ]);
        expect(r.plugin('in1').liveChanges).toEqual([
            { playoutOffsetMs: 300 },
            { ingestOffsetMs: 120 },
        ]);
        expect(pending()).toEqual({ in1: false, out1: true, mux1: false, rist1: false });
        expect(running()).toEqual({
            ...ran,
            in1: { ...ran.in1, ingestOffsetMs: 120, playoutOffsetMs: 300 },
            out1: { ...ran.out1, latency: 200 },
        });
        // The box's own change went up with its journal.
        await r.shows('/modules/in1/settings/playoutOffsetMs', 300);
        expect(r.stored().modules.in1.settings).toEqual({
            port: 9000,
            mode: 'listener',
            ingestOffsetMs: 120,
            playoutOffsetMs: 300,
        });
        expect(r.lcpOps.filter((op) => op.op === 'remove')).toEqual([]);
    }, 30_000);
});
