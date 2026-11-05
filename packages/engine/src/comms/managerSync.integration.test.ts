import { describe, it, expect, afterEach } from 'vitest';
import type { PatchOp } from '@media-router/shared-types';
import { managerRig, sleep } from './testing/managerRig.js';

/**
 * What an operator changes on the router itself reaches a manager dashboard
 * within a second and stays there (#857, BUGS.md MR-047). The drop here is
 * the one that hid every on-site change before: the router gives the link up,
 * the manager never notices, and the link comes back on the session the
 * manager kept, so no connect push follows it.
 */
const set = (path: string, value: unknown): PatchOp => ({ op: 'replace', path, value });
const volume = (value: number) => set('/modules/m1/settings/volume', value);
/** Let the patch router's 100 ms throttle hand a write on. */
const flush = () => sleep(150);

let rig: Awaited<ReturnType<typeof managerRig>> | null = null;
afterEach(async () => {
    await rig?.close();
    rig = null;
});

describe('on-site changes on the manager (#857)', () => {
    it('every local path shows on a manager dashboard within 1 s, after a drop only the router saw too', async () => {
        const r = (rig = await managerRig());
        expect(await r.routerWrite([volume(42)])).toEqual([]);
        await r.shows('/modules/m1/settings/volume', 42);

        // One write sent into the dead link before the router sees it is dead, one made while it is down.
        await r.blip({
            silent: async () => {
                await r.routerWrite([volume(50)]);
                await flush();
            },
            down: async () => {
                await r.routerWrite([set('/modules/m1/settings/volumeMax', 100)]);
                await flush();
            },
        });
        await r.shows('/modules/m1/settings/volume', 50);
        await r.shows('/modules/m1/settings/volumeMax', 100);
        expect(r.links.at(-1)).toEqual({ resumed: true });
        expect(r.pushes()).toBe(1);

        // A router dashboard (:8081/tree), the LCP, an interlock, enabled, Start/Stop, a module restart.
        await r.routerWrite([volume(55)]);
        await r.shows('/modules/m1/settings/volume', 55);
        r.lcpPatch([volume(57)]);
        await r.shows('/modules/m1/settings/volume', 57);
        await r.routerWrite([set('/modules/a/settings/audioEnabled', true)]);
        await r.shows('/modules/a/settings/audioEnabled', true);
        await r.shows('/modules/b/settings/audioEnabled', false);
        await r.routerWrite([set('/modules/m1/enabled', false)]);
        await r.shows('/modules/m1/enabled', false);
        await r.routerWrite([set('/info/running', false)]);
        await r.shows('/info/running', false);
        r.lcpControl('start');
        await r.shows('/info/running', true);
        const mark = r.sent.length;
        await r.routerCall('/modules/m1', 'restart');
        await r.shows('/modules/m1/health', 'starting');
        // Still leaf patches: the kept session's hello holds.
        expect(r.sent.slice(mark)).toContain('statePatch');
        expect(r.sent.slice(mark)).not.toContain('state');

        expect(r.stored().modules.m1.settings).toMatchObject({ volume: 57, volumeMax: 100 });
        expect([
            r.stored().modules.a.settings.audioEnabled,
            r.stored().modules.b.settings.audioEnabled,
        ]).toEqual([true, false]);
        expect(r.stored().running).toBe(true);
        expect(r.config().modules.m1.settings.volume).toBe(57);
    }, 30_000);

    it('the manager keeps them through a new session and its own pushes; its writes still reach the router', async () => {
        const r = (rig = await managerRig());
        await r.blip({
            down: async () => {
                await r.routerWrite([volume(61)]);
                await flush();
            },
        });
        await r.shows('/modules/m1/settings/volume', 61);
        await r.routerWrite([volume(62), set('/modules/a/settings/audioEnabled', true)]);
        await r.shows('/modules/m1/settings/volume', 62);
        await r.routerWrite([set('/info/running', false)]);
        await r.shows('/info/running', false);
        const from = r.seen.length;
        const kept = () => {
            expect(r.shown('/modules/m1/settings/volume')).toBe(62);
            expect(r.shown('/modules/a/settings/audioEnabled')).toBe(true);
            expect(r.shown('/modules/b/settings/audioEnabled')).toBe(false);
            expect(r.stored().modules.m1.settings.volume).toBe(62);
            expect(r.config().modules.m1.settings.volume).toBe(62);
            expect([
                r.config().modules.a.settings.audioEnabled,
                r.config().modules.b.settings.audioEnabled,
            ]).toEqual([true, false]);
        };

        // The manager drops the session: the router is back on a new one, with its connect push.
        await r.newSession();
        expect(r.links.at(-1)).toEqual({ resumed: false });
        await sleep(500);
        kept();
        expect(r.running()).toBe(false);
        expect(r.stored().running).toBe(false);
        expect(r.shown('/info/running')).toBe(false);

        // The manager's own Start: an activation push of its stored config.
        const pushes = r.pushes();
        r.manager.engineCommands.setRunning('e1', true);
        r.manager.engineCommands.sendCommand('e1', 'start');
        await sleep(500);
        expect(r.pushes()).toBe(pushes + 1);
        expect(r.running()).toBe(true);
        kept();
        const volumes = r.seen.slice(from).filter((op) => op.path.endsWith('/m1/settings/volume'));
        expect(volumes.every((op) => op.value === 62)).toBe(true);

        // Manager to router, as before.
        await r.managerWrite([volume(33)]);
        const t0 = Date.now();
        while (r.config().modules.m1.settings.volume !== 33 && Date.now() - t0 < 1000)
            await sleep(10);
        expect(r.config().modules.m1.settings.volume).toBe(33);
    }, 30_000);
});
