/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { applyTreeOps, dropUncovered, applyRenamed } from './mirror';
import { useEngineStore } from '@/stores/engines';
import { useVuStore } from '@/stores/vuMeters';
import { useLogStore } from '@/stores/logs';
import { useDeviceStore } from '@/stores/devices';
import { useEngineGroupsStore } from '@/stores/engineGroups';

const hooks = { onRebootFailed: vi.fn() };

const engineSnapshot = {
    info: { name: 'One', online: true, running: true, moduleCount: 1, connectionCount: 0 },
    system: { cpu: 10, mem: 20, temp: null },
    devices: { 'audio-sink': [{ name: 'hw:0', label: 'Card' }] },
    logs: [{ level: 30, time: 't', name: 'x', msg: 'hello' }],
    modules: { m1: { pluginId: 'p', displayName: 'M1', health: 'ok', badges: [{ id: 'b', text: 'AES' }], vu: [-6, -7] } },
    connections: [],
    interlocks: [],
    profiles: { default: { name: 'default', active: true } },
};

describe('tree mirror', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        hooks.onRebootFailed.mockReset();
    });

    it('creates engines from info and applies field changes', () => {
        applyTreeOps([{ op: 'add', path: '/engines/e1/info', value: { name: 'One', online: true, moduleCount: 3 } }], hooks);
        const engines = useEngineStore();
        expect(engines.getEngine('e1')).toMatchObject({ name: 'One', online: true, moduleCount: 3 });
        applyTreeOps([{ op: 'replace', path: '/engines/e1/info/online', value: false }], hooks);
        expect(engines.getEngine('e1')?.online).toBe(false);
    });

    it('splits a whole-engine snapshot into every store', () => {
        applyTreeOps([{ op: 'add', path: '/engines/e1', value: engineSnapshot }], hooks);
        const e = useEngineStore().getEngine('e1')!;
        expect(e.modules.m1).toMatchObject({ instanceId: 'm1', health: 'ok', badges: [{ id: 'b', text: 'AES' }] });
        expect(e.system).toEqual({ cpu: 10, mem: 20, temp: null });
        expect(e.profiles).toEqual({ default: { name: 'default', active: true } });
        expect(useVuStore().get('e1', 'm1')).toEqual([-6, -7]);
        expect(useLogStore().getEntries('e1')).toHaveLength(1);
        expect(useDeviceStore().get('e1', 'audio-sink')).toEqual([{ name: 'hw:0', label: 'Card' }]);
    });

    it('writes runtime fields in place and routes VU and log appends', () => {
        applyTreeOps([{ op: 'add', path: '/engines/e1', value: engineSnapshot }], hooks);
        const engines = useEngineStore();
        const before = engines.engines;
        applyTreeOps([
            { op: 'replace', path: '/engines/e1/modules/m1/health', value: 'warning' },
            { op: 'replace', path: '/engines/e1/modules/m1/vu', value: [-3] },
            { op: 'add', path: '/engines/e1/logs/-', value: { level: 40, time: 't2', name: 'x', msg: 'w' } },
        ], hooks);
        expect(engines.getEngine('e1')!.modules.m1.health).toBe('warning');
        expect(engines.engines).toBe(before);
        expect(useVuStore().get('e1', 'm1')).toEqual([-3]);
        expect(useLogStore().getEntries('e1')).toHaveLength(2);
    });

    it('drops branches no remaining pattern covers, keeping info', () => {
        applyTreeOps([{ op: 'add', path: '/engines/e1', value: engineSnapshot }], hooks);
        dropUncovered(['/engines/e1'], ['/engines/+/info', '/engines/+/system']);
        const e = useEngineStore().getEngine('e1')!;
        expect(e.modules).toEqual({});
        expect(e.name).toBe('One');
        expect(e.system).toBeDefined();
        expect(useLogStore().getEntries('e1')).toHaveLength(0);
        expect(useVuStore().get('e1', 'm1')).toBeUndefined();
    });

    it('applies group rows and the reboot-failed event', () => {
        applyTreeOps([{ op: 'add', path: '/groups', value: { g1: { id: 'g1', name: 'G', sort_order: 1 } } }], hooks);
        expect(useEngineGroupsStore().groups.get('g1')?.name).toBe('G');
        applyTreeOps([{ op: 'remove', path: '/groups/g1' }], hooks);
        expect(useEngineGroupsStore().groups.has('g1')).toBe(false);
        applyTreeOps([{ op: 'add', path: '/engines/e1/events/-', value: { type: 'rebootFailed', reason: 'polkit' } }], hooks);
        expect(hooks.onRebootFailed).toHaveBeenCalledWith('e1', 'polkit');
    });

    it('re-keys every store on a rename', () => {
        applyTreeOps([{ op: 'add', path: '/engines/e1', value: engineSnapshot }], hooks);
        applyRenamed({ from: '/engines/e1', to: '/engines/e9' });
        expect(useEngineStore().getEngine('e9')?.name).toBe('One');
        expect(useVuStore().get('e9', 'm1')).toEqual([-6, -7]);
        expect(useLogStore().getEntries('e9')).toHaveLength(1);
    });
});
