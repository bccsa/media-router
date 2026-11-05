import { describe, it, expect, vi } from 'vitest';
import type { PatchOp } from '@media-router/shared-types';
import { LocalChanges } from './LocalChanges.js';

const vol = (value: number, id = 'm1'): PatchOp => ({ op: 'replace', path: `/modules/${id}/settings/volume`, value });
const guaranteed = expect.objectContaining({ guaranteeDelivery: true });
const pushed = () => ({
    modules: { m1: { pluginId: 'mixer', settings: { volume: 100, mute: false } } },
    connections: [{ id: 'c1' }],
});

function setup() {
    const link = { isConnected: true, send: vi.fn() };
    const lc = new LocalChanges(link);
    const sync = (profile = 'p') => lc.markSynced(lc.merge(pushed(), { reason: 'connect', profile }).replay);
    /** The manager acks the nth message sent. */
    const ack = (n: number) => link.send.mock.calls[n][2].onAck();
    const patches = () => link.send.mock.calls.filter(([topic]) => topic === 'patch').map(([, m]) => m.ops);
    return { link, lc, sync, ack, patches };
}

describe('LocalChanges', () => {
    it('linked: config and run changes go straight up, guaranteed', () => {
        const { link, lc, sync } = setup();
        sync();
        lc.config([vol(90)]);
        lc.running(false);
        expect(link.send).toHaveBeenCalledWith('patch', { ops: [vol(90)] }, guaranteed);
        expect(link.send).toHaveBeenCalledWith('lcpEngineCommand', { command: 'stop' }, guaranteed);
    });

    it('journals while the link is down, and until the connect push is merged', () => {
        const { link, lc, sync } = setup();
        sync();
        lc.linkDown();
        lc.config([vol(90)]);
        expect(link.send).not.toHaveBeenCalled();
        sync();
        lc.linkDown();
        lc.config([vol(80)]);
        expect(link.send.mock.calls.map(([t, m]) => [t, m])).toEqual([['patch', { ops: [vol(90)] }]]);
    });

    it('drops what was journaled before the first push: no profile to match it to', () => {
        const { link, lc, sync } = setup();
        lc.config([vol(90)]);
        sync();
        expect(link.send).not.toHaveBeenCalled();
    });

    it('keeps the latest op per path; a node write supersedes its children', () => {
        const { lc } = setup();
        lc.profile = 'p';
        lc.config([vol(90), { op: 'replace', path: '/modules/m1/settings/mute', value: true }, vol(70)]);
        lc.config([{ op: 'replace', path: '/modules/m1/enabled', value: false }]);
        const { replay } = lc.merge(pushed(), { reason: 'connect', profile: 'p' });
        expect(replay.map((o) => [o.path, o.value])).toEqual([
            ['/modules/m1/settings/mute', true],
            ['/modules/m1/settings/volume', 70],
            ['/modules/m1/enabled', false],
        ]);
        lc.config([{ op: 'replace', path: '/modules/m1/settings/volume', value: 1 }]);
        lc.config([{ op: 'replace', path: '/modules/m1/settings', value: { volume: 5 } }]);
        expect(lc.merge(pushed(), { reason: 'connect', profile: 'p' }).replay).toEqual([
            { op: 'replace', path: '/modules/m1/settings', value: { volume: 5 } },
        ]);
    });

    it('merge lays the journal over the push: the on-site value wins', () => {
        const { lc, sync } = setup();
        sync();
        lc.linkDown();
        lc.config([vol(40)]);
        const base = pushed();
        const { config, replay } = lc.merge(base, { reason: 'connect', profile: 'p' });
        expect((config.modules as any).m1.settings).toEqual({ volume: 40, mute: false });
        expect((base.modules as any).m1.settings.volume).toBe(100);
        expect(replay).toEqual([vol(40)]);
    });

    it('drops entries for modules and connections the manager no longer has', () => {
        const { lc, sync } = setup();
        sync();
        lc.linkDown();
        lc.config([vol(40, 'gone'), { op: 'remove', path: '/connections/c9' }, vol(60)]);
        expect(lc.merge(pushed(), { reason: 'connect', profile: 'p' }).replay).toEqual([vol(60)]);
    });

    it('drops the whole journal on another profile or an activation', () => {
        const { lc, sync } = setup();
        sync('p');
        lc.linkDown();
        lc.config([vol(40)]);
        expect(lc.merge(pushed(), { reason: 'connect', profile: 'q' }).replay).toEqual([]);
        expect(lc.profile).toBe('q');
        lc.config([vol(30)]);
        expect(lc.merge(pushed(), { reason: 'activate', profile: 'q' }).replay).toEqual([]);
        lc.config([vol(20)]);
        expect(lc.merge(pushed(), undefined).replay).toEqual([]);
    });

    it('an outage Start/Stop is reported once; one made before the merge goes up after it', () => {
        const { link, lc, sync } = setup();
        sync();
        lc.linkDown();
        lc.running(false);
        expect(lc.takeRunChange()).toBe(true);
        expect(lc.takeRunChange()).toBe(false);
        lc.running(true);
        sync();
        expect(link.send).toHaveBeenLastCalledWith('lcpEngineCommand', { command: 'start' }, guaranteed);
    });

    it('a link back on the session the manager kept gets no push: the journal goes up and changes go live (#857)', () => {
        const { link, lc, sync, patches } = setup();
        sync();
        lc.linkDown();
        lc.config([vol(40)]);
        expect(link.send).not.toHaveBeenCalled();
        lc.resumed();
        expect(patches()).toEqual([[vol(40)]]);
        lc.config([vol(30)]);
        expect(patches()).toEqual([[vol(40)], [vol(30)]]);
        lc.resumed();
        expect(link.send).toHaveBeenCalledTimes(2);
    });

    it('a session that dropped before its push was merged keeps waiting for it', () => {
        const { link, lc, sync, patches } = setup();
        sync();
        lc.linkDown();
        lc.config([vol(40)]);
        // A new session, down again before its push came, then kept by the manager.
        lc.linkDown();
        lc.resumed();
        lc.config([vol(35)]);
        expect(link.send).not.toHaveBeenCalled();
        sync();
        expect(patches()).toEqual([[vol(35)]]);
    });

    it('what the manager had not acked when the link dropped goes up again; what it acked does not (#857)', () => {
        const { lc, sync, ack, patches } = setup();
        sync();
        const mute = { op: 'replace' as const, path: '/modules/m1/settings/mute', value: true };
        lc.config([vol(40)]);
        lc.config([mute]);
        ack(1);
        lc.linkDown();
        lc.config([vol(5, 'm2')]);
        lc.resumed();
        expect(patches()).toEqual([[vol(40)], [mute], [vol(40), vol(5, 'm2')]]);
        // That replay is not acked either: a second drop sends it once more, here laid over the connect push.
        lc.linkDown();
        const { replay } = lc.merge({ ...pushed(), modules: { ...pushed().modules, m2: {} } }, { reason: 'connect', profile: 'p' });
        expect(replay).toEqual([vol(40), vol(5, 'm2')]);
    });

    it('an older ack leaves a newer op on its path unacked', () => {
        const { lc, sync, ack, patches } = setup();
        sync();
        lc.config([vol(40)]);
        lc.config([vol(30)]);
        ack(0);
        lc.linkDown();
        lc.resumed();
        expect(patches()).toEqual([[vol(40)], [vol(30)], [vol(30)]]);
    });

    it('a Start/Stop the manager had not acked is reported again after the drop', () => {
        const { lc, sync, ack } = setup();
        sync();
        lc.running(false);
        lc.running(true);
        // The Stop's ack: the Start is still out.
        ack(0);
        lc.linkDown();
        expect(lc.takeRunChange()).toBe(true);
        lc.resumed();
        lc.running(false);
        ack(2);
        lc.linkDown();
        expect(lc.takeRunChange()).toBe(false);
    });

    it('markSynced replays the journal, guaranteed', () => {
        const { link, lc, sync } = setup();
        sync();
        lc.linkDown();
        lc.config([vol(40)]);
        link.send.mockClear();
        sync();
        expect(link.send).toHaveBeenCalledWith('patch', { ops: [vol(40)] }, guaranteed);
    });
});
