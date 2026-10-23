import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv from 'ajv';
import { ModuleManager } from './ModuleManager.js';
import { PluginLoader } from '../plugins/PluginLoader.js';
import { GstInspectTimeoutError } from '../plugins/gstInspect.js';
import type { PluginModule } from '../plugins/PluginModule.js';
import { EnginePatchRouter } from '../EnginePatchRouter.js';
import {
    ModuleWriteCheck,
    parseManifestTiming,
    withIngestTimingSettings,
    type ModuleRuntimeState,
    type PluginManifest,
} from '@media-router/shared-types';

describe('ModuleManager', () => {
    let manager: ModuleManager;
    let pluginLoader: PluginLoader;

    beforeEach(() => {
        pluginLoader = new PluginLoader('/nonexistent'); // no real plugins needed
        manager = new ModuleManager(pluginLoader);
    });

    it('creates a module', () => {
        const mod = manager.createModule('test-1', 'example', { message: 'hello' });
        expect(mod.instanceId).toBe('test-1');
        expect(mod.pluginId).toBe('example');
        expect(manager.size).toBe(1);
    });

    it('starts and stops a module', async () => {
        manager.createModule('test-1', 'example', {});
        await manager.startModule('test-1');

        const mod = manager.get('test-1')!;
        expect(mod.running).toBe(true);

        await manager.stopModule('test-1');
        expect(mod.running).toBe(false);
    });

    it('emits stateChange on start/stop', async () => {
        manager.createModule('test-1', 'example', {});

        const states: Array<{ id: string; state: ModuleRuntimeState }> = [];
        manager.on('stateChange', (id: string, state: ModuleRuntimeState) => {
            states.push({ id, state });
        });

        await manager.startModule('test-1');
        await manager.stopModule('test-1');

        expect(states.length).toBeGreaterThanOrEqual(2);
        expect(states[0].id).toBe('test-1');
    });

    it('deletes a module', async () => {
        manager.createModule('test-1', 'example', {});
        await manager.deleteModule('test-1');
        expect(manager.size).toBe(0);
        expect(manager.get('test-1')).toBeUndefined();
    });

    it('stops all modules', async () => {
        manager.createModule('a', 'example', {});
        manager.createModule('b', 'example', {});
        await manager.startModule('a');
        await manager.startModule('b');

        await manager.stopAll();
        expect(manager.get('a')!.running).toBe(false);
        expect(manager.get('b')!.running).toBe(false);
    });

    it('getAllStates returns all module states', () => {
        manager.createModule('a', 'example', {});
        manager.createModule('b', 'example', {});

        const states = manager.getAllStates();
        expect(Object.keys(states)).toEqual(['a', 'b']);
        expect(states.a.health).toBe('stopped');
    });

    it('throws on duplicate instanceId', () => {
        manager.createModule('dup', 'example', {});
        expect(() => manager.createModule('dup', 'example', {})).toThrow('already exists');
    });

    it("each start waits for the plugin's settle; one that timed out fails the start (B-102)", async () => {
        let release!: () => void;
        const settle = vi
            .spyOn(pluginLoader, 'settle')
            .mockImplementationOnce(() => new Promise<void>((r) => (release = r)))
            .mockRejectedValueOnce(new GstInspectTimeoutError(['x264enc']));
        const mod = manager.createModule('enc', 'video-encoder', {});

        const started = manager.startModule('enc');
        await new Promise((r) => setTimeout(r, 10));
        expect(settle).toHaveBeenCalledWith('video-encoder');
        expect(mod.running).toBe(false);
        release();
        await started;
        expect(mod.running).toBe(true);

        await manager.stopModule('enc');
        await expect(manager.startModule('enc')).rejects.toThrow('x264enc timed out after 30 s');
        expect(mod.running).toBe(false);

        // The next start settles again (the real one: nothing due) and runs.
        await manager.startModule('enc');
        expect(settle).toHaveBeenCalledTimes(3);
        expect(mod.running).toBe(true);
    });
});

/** The six plugins whose volume follows Volume Range (`x-maxFrom: volumeMax`). */
const RANGED = [
    'audio-decoder',
    'audio-output',
    'audio-output-302m',
    'audio-encoder',
    'audio-input-302m',
    'audio-input',
];

/** A plugin's manifest from its package.json, with the timing settings PluginLoader adds. */
function manifestOf(pluginId: string): PluginManifest {
    const pluginsDir = join(__dirname, '..', '..', '..', '..', 'plugins');
    const pkg = JSON.parse(readFileSync(join(pluginsDir, pluginId, 'package.json'), 'utf8'));
    const manifest = pkg.mediaRouter as PluginManifest;
    const timing = parseManifestTiming(pkg.mediaRouter.timing);
    if (!timing) return manifest;
    return { ...manifest, configSchema: withIngestTimingSettings(manifest.configSchema, timing) };
}

/** A plugin that records the settings it starts with and its live updates. */
function recordingPlugin(
    inits: Record<string, unknown>[],
    live: Record<string, unknown>[],
): PluginModule {
    return {
        async onInit(config) {
            inits.push({ ...config });
        },
        async onStart() {},
        async onStop() {},
        async onDestroy() {},
        getState: () => ({ running: true, ready: true, health: 'ok', pendingRestart: false }),
        getLiveUpdatableParams: () => ['volume'],
        async onLiveConfigUpdate(changes) {
            live.push(changes);
        },
    };
}

describe("a module's settings at start, by the manager's maxima (B-103)", () => {
    const manifests = new Map(RANGED.map((id) => [id, manifestOf(id)]));
    let pluginLoader: PluginLoader;
    let manager: ModuleManager;
    let n = 0;

    beforeEach(() => {
        pluginLoader = new PluginLoader('/nonexistent');
        vi.spyOn(pluginLoader, 'get').mockImplementation((id) => {
            const manifest = manifests.get(id);
            return manifest ? { manifest, ModuleClass: null } : undefined;
        });
        manager = new ModuleManager(pluginLoader);
    });

    /** The settings a new module of `pluginId` holds once created from `settings`. */
    const started = (pluginId: string, settings: Record<string, unknown>) =>
        manager.createModule(`m${++n}`, pluginId, { ...settings }).config;

    /** The manager's check of a setting write (TreeWrites; a router's own tree too): null = taken. */
    const managerCheck = (
        pluginId: string,
        settings: Record<string, unknown>,
        key: string,
        value: unknown,
    ) =>
        new ModuleWriteCheck(() => ({
            settings,
            configSchema: manifests.get(pluginId)!.configSchema,
        })).check('m', ['settings', key], {
            op: 'replace',
            path: `/modules/m/settings/${key}`,
            value,
        });

    it('keeps 500 % in a Volume Range of 500, which the manager takes', () => {
        expect(managerCheck('audio-input-302m', { volumeMax: 500 }, 'volume', 500)).toBeNull();
        expect(started('audio-input-302m', { volumeMax: 500, volume: 500 })).toMatchObject({
            volumeMax: 500,
            volume: 500,
        });
    });

    it('resets 500 % in a Volume Range of 150 to its default: the manager refuses it', () => {
        expect(managerCheck('audio-input-302m', { volumeMax: 150 }, 'volume', 500)).toBe(
            'above maximum 150',
        );
        expect(started('audio-input-302m', { volumeMax: 150, volume: 500 })).toMatchObject({
            volumeMax: 150,
            volume: 100,
        });
    });

    it('a Volume Range lowered under the volume: the volume resets, as the manager refuses it', () => {
        // Nothing clamps the stored volume when the range comes down.
        expect(managerCheck('audio-output', { volumeMax: 100 }, 'volume', 140)).toBe(
            'above maximum 100',
        );
        expect(started('audio-output', { volumeMax: 100, volume: 140 })).toMatchObject({
            volumeMax: 100,
            volume: 100,
        });
        expect(started('audio-output', { volumeMax: 200, volume: 300 }).volume).toBe(100);
        expect(started('audio-output', { volumeMax: 200, volume: 200 }).volume).toBe(200);
    });

    it('a missing or non-numeric Volume Range bounds the volume at the static 150, as for the manager', () => {
        expect(started('audio-output', { volume: 150 })).toMatchObject({
            volumeMax: 150,
            volume: 150,
        });
        expect(started('audio-output', { volume: 151 }).volume).toBe(100);
        expect(managerCheck('audio-output', { volumeMax: '500' }, 'volume', 300)).toBe(
            'above maximum 150',
        );
        expect(started('audio-output', { volumeMax: '500', volume: 300 })).toMatchObject({
            volumeMax: 150,
            volume: 100,
        });
    });

    it('a Volume Range outside its options still bounds the volume as for the manager; it resets', () => {
        expect(managerCheck('audio-output', { volumeMax: 250 }, 'volume', 250)).toBeNull();
        expect(started('audio-output', { volumeMax: 250, volume: 250 })).toMatchObject({
            volumeMax: 150,
            volume: 250,
        });
    });

    it('a maximum no other setting moves is still the bound (Capture Buffer, 40-85 ms)', () => {
        const at = (srcBufferMs: number) =>
            started('audio-input-302m', { volumeMax: 500, srcBufferMs }).srcBufferMs;
        expect([at(85), at(86), at(100)]).toEqual([85, 60, 60]);
    });

    it("x-maxBy too: Audio Encoder's bitrate is bounded at 320 kbps for AAC, 510 for Opus", () => {
        expect(started('audio-encoder', { codec: 'opus', bitrate: 400 }).bitrate).toBe(400);
        expect(managerCheck('audio-encoder', { codec: 'aac' }, 'bitrate', 400)).toBe(
            'above maximum 320',
        );
        expect(started('audio-encoder', { codec: 'aac', bitrate: 400 }).bitrate).toBe(128);
        expect(started('audio-encoder', { codec: 'aac', bitrate: 320 }).bitrate).toBe(320);
    });

    it('a wrong type resets to the default and a missing value takes it, as before', () => {
        expect(started('audio-output', { volume: '80' }).volume).toBe(100);
        expect(started('audio-output', {})).toMatchObject({ volume: 100, volumeMax: 150 });
    });

    it('compiles a schema with moved maxima once per set of maxima, not at every start', () => {
        // A fresh manifest object: none of its copies compiled yet. ajv keeps every compile.
        const manifest = manifestOf('audio-input');
        vi.mocked(pluginLoader.get).mockReturnValue({ manifest, ModuleClass: null });
        const compile = vi.spyOn(Ajv.prototype, 'compile');
        try {
            for (let i = 0; i < 20; i++) started('audio-input', { volumeMax: 300, volume: 250 });
            expect(compile).toHaveBeenCalledTimes(1);
            started('audio-input', { volumeMax: 500, volume: 450 });
            started('audio-input', { volumeMax: 300, volume: 120 });
            expect(compile).toHaveBeenCalledTimes(2);
            expect(compile.mock.calls[0][0]).not.toBe(manifest.configSchema);
        } finally {
            compile.mockRestore();
        }
    });

    it.each(RANGED)(
        '%s: the start keeps exactly the volumes the manager takes, in every Volume Range',
        (pluginId) => {
            const schema = manifests.get(pluginId)!.configSchema as {
                properties: Record<string, { enum?: number[] }>;
            };
            const ranges = schema.properties.volumeMax.enum!;
            expect(ranges).toEqual([100, 150, 200, 300, 500]);
            const outcomes = new Set<boolean>();
            for (const volumeMax of ranges) {
                for (const volume of [
                    -1, 0, 99, 101, 149, 150, 151, 199, 200, 201, 300, 301, 500, 501,
                ]) {
                    const taken = managerCheck(pluginId, { volumeMax }, 'volume', volume) === null;
                    const kept = started(pluginId, { volumeMax, volume }).volume === volume;
                    expect({ volumeMax, volume, kept }).toEqual({ volumeMax, volume, kept: taken });
                    outcomes.add(kept);
                }
            }
            expect(outcomes).toEqual(new Set([true, false]));
        },
    );

    it('the live path and the next start agree: 500 % set live in a range of 500 runs after a restart', async () => {
        // The ATEM input on the Pi 4 test box: Volume Range 500, its volume raised live from 132 %.
        const config: Record<string, unknown> = {
            modules: {
                atem: {
                    pluginId: 'audio-input-302m',
                    enabled: true,
                    settings: { volumeMax: 500, volume: 132 },
                },
            },
            connections: [],
        };
        const settings = () => (config.modules as any).atem.settings as Record<string, unknown>;
        const inits: Record<string, unknown>[] = [];
        const live: Record<string, unknown>[] = [];
        manager.createModule('atem', 'audio-input-302m', settings(), recordingPlugin(inits, live));
        await manager.startModule('atem');

        // The manager takes the write; the engine's patch router applies it to its config and,
        // live, to the module.
        expect(managerCheck('audio-input-302m', settings(), 'volume', 500)).toBeNull();
        const patches = new EnginePatchRouter(
            manager,
            {} as any,
            { configChanged: vi.fn() } as any,
            { config: vi.fn() } as any,
            { refreshPorts: vi.fn() } as any,
            () => config,
            () => true,
        );
        patches.onPatch('manager', 'manager', [
            { op: 'replace', path: '/modules/atem/settings/volume', value: 500 },
        ]);
        await vi.waitFor(() => expect(live).toEqual([{ volume: 500 }]));
        expect(settings().volume).toBe(500);

        // An engine restart: a new engine creates the module from those settings (startAll).
        const restarted = new ModuleManager(pluginLoader);
        restarted.createModule(
            'atem',
            'audio-input-302m',
            { ...settings() },
            recordingPlugin(inits, live),
        );
        await restarted.startModule('atem');
        expect(inits.map((s) => s.volume)).toEqual([132, 500]);
    });
});
