/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const mockApplyEnginePatch = vi.fn();
const mockEmit = vi.fn();

vi.mock('@/stores/engines', () => ({
    useEngineStore: () => ({ applyEnginePatch: mockApplyEnginePatch }),
}));

vi.mock('@/stores/socket', () => ({
    useSocketStore: () => ({ emit: mockEmit }),
}));

import { patch } from './usePatch';

describe('usePatch', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        mockApplyEnginePatch.mockClear();
        mockEmit.mockClear();
    });

    it('moduleSetting sends a replace op for a setting key', () => {
        patch.moduleSetting('eng-1', 'mod-1', 'volume', 80);

        const expectedOps = [{ op: 'replace', path: '/modules/mod-1/settings/volume', value: 80 }];
        expect(mockApplyEnginePatch).toHaveBeenCalledWith('eng-1', expectedOps);
        expect(mockEmit).toHaveBeenCalledWith('patch', { engineId: 'eng-1', ops: expectedOps });
    });

    it('moduleSettings sends multiple replace ops', () => {
        patch.moduleSettings('eng-1', 'mod-1', { volume: 80, device: 'mic-1' });

        expect(mockApplyEnginePatch).toHaveBeenCalledOnce();
        const ops = mockApplyEnginePatch.mock.calls[0][1];
        expect(ops).toHaveLength(2);
        expect(ops).toContainEqual({
            op: 'replace',
            path: '/modules/mod-1/settings/volume',
            value: 80,
        });
        expect(ops).toContainEqual({
            op: 'replace',
            path: '/modules/mod-1/settings/device',
            value: 'mic-1',
        });
    });

    it('moduleRename sends a replace op for displayName', () => {
        patch.moduleRename('eng-1', 'mod-1', 'New Name');

        const expectedOps = [
            { op: 'replace', path: '/modules/mod-1/displayName', value: 'New Name' },
        ];
        expect(mockApplyEnginePatch).toHaveBeenCalledWith('eng-1', expectedOps);
        expect(mockEmit).toHaveBeenCalledWith('patch', { engineId: 'eng-1', ops: expectedOps });
    });

    it('modulePosition sends a replace op for position', () => {
        patch.modulePosition('eng-1', 'mod-1', { x: 100, y: 200 });

        const expectedOps = [
            { op: 'replace', path: '/modules/mod-1/position', value: { x: 100, y: 200 } },
        ];
        expect(mockApplyEnginePatch).toHaveBeenCalledWith('eng-1', expectedOps);
    });

    it('moduleField sends a replace op for an arbitrary field', () => {
        patch.moduleField('eng-1', 'mod-1', 'focused', true);

        const expectedOps = [{ op: 'replace', path: '/modules/mod-1/focused', value: true }];
        expect(mockApplyEnginePatch).toHaveBeenCalledWith('eng-1', expectedOps);
    });

    it('moduleToggle sends a replace op for enabled', () => {
        patch.moduleToggle('eng-1', 'mod-1', false);

        const expectedOps = [{ op: 'replace', path: '/modules/mod-1/enabled', value: false }];
        expect(mockApplyEnginePatch).toHaveBeenCalledWith('eng-1', expectedOps);
    });

    it('addModule sends an add op with the module value', () => {
        const moduleData = { pluginId: 'audio-input', displayName: 'Mic 1', settings: {} };
        patch.addModule('eng-1', 'mod-new', moduleData);

        const expectedOps = [{ op: 'add', path: '/modules/mod-new', value: moduleData }];
        expect(mockApplyEnginePatch).toHaveBeenCalledWith('eng-1', expectedOps);
        expect(mockEmit).toHaveBeenCalledWith('patch', { engineId: 'eng-1', ops: expectedOps });
    });

    it('removeModule sends a remove op', () => {
        patch.removeModule('eng-1', 'mod-1');

        const expectedOps = [{ op: 'remove', path: '/modules/mod-1' }];
        expect(mockApplyEnginePatch).toHaveBeenCalledWith('eng-1', expectedOps);
        expect(mockEmit).toHaveBeenCalledWith('patch', { engineId: 'eng-1', ops: expectedOps });
    });

    it('addConnection sends an add op with /connections/-', () => {
        const conn = {
            sourceModuleId: 'mod-1',
            sourcePortId: 'out',
            sinkModuleId: 'mod-2',
            sinkPortId: 'in',
        };
        patch.addConnection('eng-1', conn);

        const expectedOps = [{ op: 'add', path: '/connections/-', value: conn }];
        expect(mockApplyEnginePatch).toHaveBeenCalledWith('eng-1', expectedOps);
    });

    it('removeConnection sends a remove op for the connection', () => {
        patch.removeConnection('eng-1', 'conn-1');

        const expectedOps = [{ op: 'remove', path: '/connections/conn-1' }];
        expect(mockApplyEnginePatch).toHaveBeenCalledWith('eng-1', expectedOps);
    });

    it('connectionField sends a replace op for a connection field', () => {
        patch.connectionField('eng-1', 'conn-1', 'enabled', false);

        const expectedOps = [{ op: 'replace', path: '/connections/conn-1/enabled', value: false }];
        expect(mockApplyEnginePatch).toHaveBeenCalledWith('eng-1', expectedOps);
    });

    it('raw sends arbitrary ops', () => {
        const ops = [
            { op: 'replace' as const, path: '/online', value: false },
            { op: 'remove' as const, path: '/modules/mod-1' },
        ];
        patch.raw('eng-1', ops);

        expect(mockApplyEnginePatch).toHaveBeenCalledWith('eng-1', ops);
        expect(mockEmit).toHaveBeenCalledWith('patch', { engineId: 'eng-1', ops });
    });

    it('always applies optimistically before emitting to socket', () => {
        patch.moduleSetting('eng-1', 'mod-1', 'gain', 5);

        // applyEnginePatch should be called before emit
        const applyOrder = mockApplyEnginePatch.mock.invocationCallOrder[0];
        const emitOrder = mockEmit.mock.invocationCallOrder[0];
        expect(applyOrder).toBeLessThan(emitOrder);
    });
});
