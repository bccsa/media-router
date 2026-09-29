import { describe, it, expect, vi } from 'vitest';
import type { PatchOp } from '@media-router/shared-types';
import { LocalChanges } from './LocalChanges.js';

const vol = (value: number, id = 'm1'): PatchOp => ({ op: 'replace', path: `/modules/${id}/settings/volume`, value });
const pushed = () => ({
    modules: { m1: { pluginId: 'mixer', settings: { volume: 100, mute: false } } },
    connections: [{ id: 'c1' }],
});

function setup() {
    const link = { isConnected: true, send: vi.fn() };
    const lc = new LocalChanges(link);
    const sync = (profile = 'p') => lc.markSynced(lc.merge(pushed(), { reason: 'connect', profile }).replay);
    return { link, lc, sync };
}

describe('LocalChanges', () => {
    it('linked: config and run changes go straight up, guaranteed', () => {
        const { link, lc, sync } = setup();
        sync();
        lc.config([vol(90)]);
        lc.running(false);
        expect(link.send).toHaveBeenCalledWith('patch', { ops: [vol(90)] }, { guaranteeDelivery: true });
        expect(link.send).toHaveBeenCalledWith('lcpEngineCommand', { command: 'stop' }, { guaranteeDelivery: true });
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
        expect(link.send).toHaveBeenLastCalledWith('lcpEngineCommand', { command: 'start' }, { guaranteeDelivery: true });
    });

    it('markSynced replays the journal, guaranteed', () => {
        const { link, lc, sync } = setup();
        sync();
        lc.linkDown();
        lc.config([vol(40)]);
        link.send.mockClear();
        sync();
        expect(link.send).toHaveBeenCalledWith('patch', { ops: [vol(40)] }, { guaranteeDelivery: true });
    });
});
