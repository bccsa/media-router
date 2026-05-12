/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const mockApplyEnginePatch = vi.fn();
const mockEmit = vi.fn();
const mockGetEngine = vi.fn();

vi.mock('@/stores/engines', () => ({
    useEngineStore: () => ({
        applyEnginePatch: mockApplyEnginePatch,
        getEngine: mockGetEngine,
    }),
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
        mockGetEngine.mockReset();
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

    describe('cloneModule', () => {
        const sourceModule = {
            instanceId: 'mod-src',
            pluginId: 'audio-input',
            displayName: 'Mic 1',
            position: { x: 100, y: 200 },
            settings: { gain: 5, device: 'mic-1' },
            ports: [{ id: 'out', direction: 'out' as const, kind: 'audio' as const }],
            configSchema: { type: 'object' },
            color: '#10b981',
            icon: 'mic',
            running: true,
            enabled: false,
            health: 'running',
        };

        it('returns undefined when source module is missing', () => {
            mockGetEngine.mockReturnValue({ modules: {} });

            const result = patch.cloneModule('eng-1', 'mod-missing');

            expect(result).toBeUndefined();
            expect(mockEmit).not.toHaveBeenCalled();
            expect(mockApplyEnginePatch).not.toHaveBeenCalled();
        });

        it('returns undefined when engine is missing', () => {
            mockGetEngine.mockReturnValue(undefined);

            const result = patch.cloneModule('eng-1', 'mod-src');

            expect(result).toBeUndefined();
            expect(mockEmit).not.toHaveBeenCalled();
        });

        it('carries manifest-derived fields (statusSections, faceWidgets, interlock, resizable) through the clone', () => {
            const withManifest = {
                ...sourceModule,
                statusSections: [{ id: 'srt', label: 'SRT', fields: [] }],
                faceWidgets: [{ id: 'vu', type: 'vu-meter' }],
                interlock: true,
                resizable: { minWidth: 200, minHeight: 100 } as const,
            };
            mockGetEngine.mockReturnValue({ modules: { 'mod-src': withManifest } });

            patch.cloneModule('eng-1', 'mod-src');

            const value = mockApplyEnginePatch.mock.calls[0][1][0].value as {
                statusSections: unknown;
                faceWidgets: unknown;
                interlock: boolean;
                resizable: unknown;
            };
            expect(value.statusSections).toEqual(withManifest.statusSections);
            expect(value.faceWidgets).toEqual(withManifest.faceWidgets);
            expect(value.interlock).toBe(true);
            expect(value.resizable).toEqual(withManifest.resizable);
        });

        it('coerces non-strict-true interlock to false', () => {
            const truthy = { ...sourceModule, interlock: 'yes' as unknown as boolean };
            mockGetEngine.mockReturnValue({ modules: { 'mod-src': truthy } });

            patch.cloneModule('eng-1', 'mod-src');

            const value = mockApplyEnginePatch.mock.calls[0][1][0].value as { interlock: boolean };
            expect(value.interlock).toBe(false);
        });

        it('emits an add op carrying all UI-critical fields from source', () => {
            mockGetEngine.mockReturnValue({ modules: { 'mod-src': sourceModule } });

            const newId = patch.cloneModule('eng-1', 'mod-src');

            expect(newId).toBeDefined();
            expect(newId).toMatch(/^audio-input-/);
            const ops = mockApplyEnginePatch.mock.calls[0][1];
            expect(ops).toHaveLength(1);
            expect(ops[0].op).toBe('add');
            expect(ops[0].path).toBe(`/modules/${newId}`);
            const value = ops[0].value;
            expect(value).toMatchObject({
                instanceId: newId,
                pluginId: 'audio-input',
                displayName: 'Mic 1 (copy)',
                position: { x: 150, y: 250 },
                settings: { gain: 5, device: 'mic-1' },
                ports: sourceModule.ports,
                configSchema: { type: 'object' },
                color: '#10b981',
                icon: 'mic',
                enabled: true,
                running: false,
                health: 'stopped',
            });
        });

        it('deep-clones settings, ports, and configSchema so mutations do not leak between source and clone', () => {
            const nested = {
                ...sourceModule,
                settings: { gain: 5, eq: { low: 1, high: 2 } },
                ports: [{ id: 'out', direction: 'out' as const, kind: 'audio' as const }],
                configSchema: { type: 'object', properties: { gain: { type: 'number' } } },
            };
            mockGetEngine.mockReturnValue({ modules: { 'mod-src': nested } });

            patch.cloneModule('eng-1', 'mod-src');

            const value = mockApplyEnginePatch.mock.calls[0][1][0].value as {
                settings: { eq: Record<string, number> };
                ports: { id: string }[];
                configSchema: { properties: Record<string, unknown> };
            };
            // Top-level references differ
            expect(value.settings).not.toBe(nested.settings);
            expect(value.ports).not.toBe(nested.ports);
            expect(value.configSchema).not.toBe(nested.configSchema);
            // Nested references differ too — proves deep, not shallow, clone
            expect(value.settings.eq).not.toBe(nested.settings.eq);
            expect(value.ports[0]).not.toBe(nested.ports[0]);
            expect(value.configSchema.properties).not.toBe(nested.configSchema.properties);
            // Values still match
            expect(value.settings).toEqual(nested.settings);
            expect(value.ports).toEqual(nested.ports);
            expect(value.configSchema).toEqual(nested.configSchema);
        });

        it('falls back to default position when source has none', () => {
            const noPos = { ...sourceModule, position: undefined };
            mockGetEngine.mockReturnValue({ modules: { 'mod-src': noPos } });

            patch.cloneModule('eng-1', 'mod-src');

            const value = mockApplyEnginePatch.mock.calls[0][1][0].value as {
                position: { x: number; y: number };
            };
            expect(value.position).toEqual({ x: 150, y: 150 });
        });

        it('defaults ports to an empty array when source has none', () => {
            const noPorts = { ...sourceModule, ports: undefined };
            mockGetEngine.mockReturnValue({ modules: { 'mod-src': noPorts } });

            patch.cloneModule('eng-1', 'mod-src');

            const value = mockApplyEnginePatch.mock.calls[0][1][0].value as { ports: unknown[] };
            expect(value.ports).toEqual([]);
        });
    });

    it('always applies optimistically before emitting to socket', () => {
        patch.moduleSetting('eng-1', 'mod-1', 'gain', 5);

        // applyEnginePatch should be called before emit
        const applyOrder = mockApplyEnginePatch.mock.invocationCallOrder[0];
        const emitOrder = mockEmit.mock.invocationCallOrder[0];
        expect(applyOrder).toBeLessThan(emitOrder);
    });
});
