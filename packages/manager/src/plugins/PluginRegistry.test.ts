import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PluginRegistry } from './PluginRegistry.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('PluginRegistry', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-registry-test-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function createPlugin(name: string, mediaRouter?: Record<string, unknown>): void {
        const pluginDir = path.join(tmpDir, name);
        fs.mkdirSync(pluginDir, { recursive: true });

        const pkg: any = { name: `@test/${name}`, version: '1.0.0' };
        if (mediaRouter) pkg.mediaRouter = mediaRouter;
        fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify(pkg));
    }

    describe('getAll', () => {
        it('scans plugins directory and returns manifests', () => {
            createPlugin('audio-input', {
                pluginId: 'audio-input',
                displayName: 'Audio Input',
                category: 'input',
                color: '#3b82f6',
                icon: 'mic',
                ports: [{ id: 'out-0', direction: 'output' }],
                configSchema: { properties: { volume: { default: 100 } } },
            });
            createPlugin('audio-output', {
                pluginId: 'audio-output',
                displayName: 'Audio Output',
                ports: [],
                configSchema: {},
            });

            const registry = new PluginRegistry(tmpDir);
            const plugins = registry.getAll();

            expect(plugins).toHaveLength(2);
            expect(plugins.map((p) => p.pluginId).sort()).toEqual(['audio-input', 'audio-output']);

            const input = plugins.find((p) => p.pluginId === 'audio-input')!;
            expect(input.displayName).toBe('Audio Input');
            expect(input.category).toBe('input');
            expect(input.color).toBe('#3b82f6');
            expect(input.icon).toBe('mic');
            expect(input.ports).toEqual([{ id: 'out-0', direction: 'output' }]);
            expect(input.configSchema).toEqual({ properties: { volume: { default: 100 } } });
        });

        it('caches results after first call', () => {
            createPlugin('plugin-a', {
                pluginId: 'a',
                displayName: 'A',
                ports: [],
                configSchema: {},
            });

            const registry = new PluginRegistry(tmpDir);
            const first = registry.getAll();
            expect(first).toHaveLength(1);

            // Add another plugin on disk — should NOT appear (cached)
            createPlugin('plugin-b', {
                pluginId: 'b',
                displayName: 'B',
                ports: [],
                configSchema: {},
            });

            const second = registry.getAll();
            expect(second).toHaveLength(1);
            expect(second).toBe(first); // same reference
        });

        it('defaults ports and configSchema when missing', () => {
            createPlugin('minimal', {
                pluginId: 'minimal',
                displayName: 'Minimal',
            });

            const registry = new PluginRegistry(tmpDir);
            const plugins = registry.getAll();
            expect(plugins).toHaveLength(1);
            expect(plugins[0].ports).toEqual([]);
            expect(plugins[0].configSchema).toEqual({});
        });
    });

    describe('find', () => {
        it('returns matching plugin by ID', () => {
            createPlugin('audio-input', {
                pluginId: 'audio-input',
                displayName: 'Audio Input',
                ports: [],
                configSchema: {},
            });

            const registry = new PluginRegistry(tmpDir);
            const found = registry.find('audio-input');
            expect(found).toBeDefined();
            expect(found!.pluginId).toBe('audio-input');
            expect(found!.displayName).toBe('Audio Input');
        });

        it('returns undefined for unknown ID', () => {
            const registry = new PluginRegistry(tmpDir);
            expect(registry.find('nonexistent')).toBeUndefined();
        });
    });

    describe('enrichModule', () => {
        it('stamps instanceId and runtime defaults onto a raw module', () => {
            createPlugin('audio-input', {
                pluginId: 'audio-input',
                displayName: 'Audio Input',
                ports: [{ id: 'out-0', direction: 'output' }],
                configSchema: {},
                resizable: true,
                interlock: true,
            });

            const registry = new PluginRegistry(tmpDir);
            const mod: Record<string, unknown> = {
                pluginId: 'audio-input',
                displayName: 'Mic',
                settings: {},
            };
            registry.enrichModule('mic-1', mod);

            expect(mod.instanceId).toBe('mic-1');
            expect(mod.enabled).toBe(true);
            expect(mod.running).toBe(false);
            expect(mod.health).toBe('stopped');
            expect(mod.pendingRestart).toBe(false);
            // Manifest fields overlaid:
            expect(mod.ports).toEqual([{ id: 'out-0', direction: 'output' }]);
            expect(mod.resizable).toBe(true);
            expect(mod.interlock).toBe(true);
        });

        it('preserves existing per-module state (does not overwrite)', () => {
            createPlugin('audio-input', {
                pluginId: 'audio-input',
                displayName: 'Audio Input',
                ports: [],
                configSchema: {},
            });

            const registry = new PluginRegistry(tmpDir);
            const mod: Record<string, unknown> = {
                pluginId: 'audio-input',
                enabled: false,
                running: true,
                health: 'ok',
                pendingRestart: true,
            };
            registry.enrichModule('mic-1', mod);

            expect(mod.enabled).toBe(false);
            expect(mod.running).toBe(true);
            expect(mod.health).toBe('ok');
            expect(mod.pendingRestart).toBe(true);
            // instanceId always stamped, even if present:
            expect(mod.instanceId).toBe('mic-1');
        });
    });

    describe('engine-reported schemas (#661)', () => {
        function makeRegistry() {
            createPlugin('transcoder', {
                pluginId: 'transcoder',
                displayName: 'Transcoder',
                ports: [],
                // Manager's own probe: software-only (e.g. an ARM manager).
                configSchema: {
                    properties: { encoderImpl: { enum: ['auto', 'software'] } },
                },
            });
            return new PluginRegistry(tmpDir);
        }

        // The engine reports hardware VA-API — an Intel engine's real caps.
        const engineSchemas = {
            transcoder: { properties: { encoderImpl: { enum: ['auto', 'va', 'software'] } } },
        };

        it('overlayManifest uses the engine schema when it carries the plugin', () => {
            const mod: Record<string, unknown> = { pluginId: 'transcoder' };
            makeRegistry().overlayManifest(mod, engineSchemas);
            expect((mod.configSchema as any).properties.encoderImpl.enum).toEqual([
                'auto',
                'va',
                'software',
            ]);
        });

        it('overlayManifest falls back to the manager schema when the engine has not reported', () => {
            const mod: Record<string, unknown> = { pluginId: 'transcoder' };
            makeRegistry().overlayManifest(mod); // no engineSchemas
            expect((mod.configSchema as any).properties.encoderImpl.enum).toEqual([
                'auto',
                'software',
            ]);
        });

        it('overlayManifest falls back when the engine schema omits this plugin', () => {
            const mod: Record<string, unknown> = { pluginId: 'transcoder' };
            makeRegistry().overlayManifest(mod, { 'other-plugin': {} });
            expect((mod.configSchema as any).properties.encoderImpl.enum).toEqual([
                'auto',
                'software',
            ]);
        });

        it('enrichModule threads the engine schema through', () => {
            const mod: Record<string, unknown> = { pluginId: 'transcoder' };
            makeRegistry().enrichModule('t-1', mod, engineSchemas);
            expect(mod.instanceId).toBe('t-1');
            expect((mod.configSchema as any).properties.encoderImpl.enum).toEqual([
                'auto',
                'va',
                'software',
            ]);
        });
    });

    describe('ingest timing settings (house-clock WI-P1-9)', () => {
        const PORT = { type: 'number', default: 9000 };
        const OFFSET = {
            type: 'number',
            default: 0,
            minimum: -10000,
            maximum: 10000,
            'x-unit': 'ms',
            'x-live': true,
            title: 'Ingest Offset',
            description:
                'Moves this input on the house timeline: positive later, negative earlier. A live edit leaves a gap or drops overlap.',
        };
        const TRIMS = {
            type: 'object',
            additionalProperties: { type: 'number', minimum: -2000, maximum: 2000 },
            default: {},
            'x-widget': 'pidTrim',
            'x-optionsFrom': 'pids',
            'x-live': true,
            'x-unit': 'ms',
            title: 'Per-PID Trim',
            description:
                "Shifts one stream against the others, on top of Ingest Offset, to correct a source's fixed A/V error.",
        };
        const COOLDOWN = {
            type: 'number',
            default: 5,
            minimum: 0,
            maximum: 60,
            'x-unit': 'min',
            'x-live': true,
            title: 'Smoothing Cooldown',
            description:
                "Adds latency only when this input's stream is bursty (packets arriving in bursts, as through some relays). The input then runs at its bursts' height and comes back down no sooner than this long after the last burst, instead of skipping and re-syncing after every burst. A steady stream gets no added latency. Set it longer than the time between bursts; 0 turns smoothing off.",
        };
        const manifest = (id: string, timing?: unknown) => ({
            pluginId: id,
            displayName: id,
            engine: './engine/TestModule.ts',
            ports: [],
            configSchema: { type: 'object', properties: { port: PORT } },
            ...(timing ? { timing } : {}),
        });

        it('only the manifests declaring `timing` get them; the trim only with pidTrims, the cooldown only with pcrLock', () => {
            createPlugin('net', manifest('net', { role: 'ingest', pidTrims: true, pcrLock: true }));
            createPlugin('cap', manifest('cap', { role: 'ingest', pidTrims: false }));
            createPlugin('trim', manifest('trim', { role: 'ingest', pidTrims: true }));
            createPlugin(
                'lock',
                manifest('lock', { role: 'ingest', pidTrims: false, pcrLock: true }),
            );
            createPlugin('out', manifest('out', { role: 'egress' }));
            createPlugin('plain', manifest('plain'));

            const schemas = Object.fromEntries(
                new PluginRegistry(tmpDir).getAll().map((p) => [p.pluginId, p.configSchema]),
            );

            expect(schemas).toEqual({
                net: {
                    type: 'object',
                    properties: {
                        port: PORT,
                        ingestOffsetMs: OFFSET,
                        pidTrimsMs: TRIMS,
                        smoothingCooldownMin: COOLDOWN,
                    },
                },
                cap: { type: 'object', properties: { port: PORT, ingestOffsetMs: OFFSET } },
                trim: {
                    type: 'object',
                    properties: { port: PORT, ingestOffsetMs: OFFSET, pidTrimsMs: TRIMS },
                },
                lock: {
                    type: 'object',
                    properties: {
                        port: PORT,
                        ingestOffsetMs: OFFSET,
                        smoothingCooldownMin: COOLDOWN,
                    },
                },
                out: { type: 'object', properties: { port: PORT } },
                plain: { type: 'object', properties: { port: PORT } },
            });
        });

        it('on the real manifests: Smoothing Cooldown on the three network ingests, not the four captures', () => {
            const schemas = new PluginRegistry(path.resolve(__dirname, '../../../../plugins'))
                .getAll()
                .filter((p) => (p.configSchema as any)?.properties?.ingestOffsetMs);
            const withCooldown = (want: boolean) =>
                schemas
                    .filter(
                        (p) =>
                            'smoothingCooldownMin' in (p.configSchema as any).properties === want,
                    )
                    .map((p) => p.pluginId)
                    .sort();
            expect(withCooldown(true)).toEqual(['mpegts-ip-input', 'rist-input', 'srt-input']);
            expect(withCooldown(false)).toEqual([
                'aes67-input',
                'audio-encoder',
                'audio-input-302m',
                'video-encoder',
            ]);
            for (const p of schemas.filter(
                (x) => 'smoothingCooldownMin' in (x.configSchema as any).properties,
            )) {
                expect((p.configSchema as any).properties.smoothingCooldownMin).toEqual(COOLDOWN);
            }
        });

        it('a module gets them through overlayManifest, and initManifest sees them', async () => {
            createPlugin('net', manifest('net', { role: 'ingest', pidTrims: true, pcrLock: true }));
            const dist = path.join(tmpDir, 'net', 'dist');
            fs.mkdirSync(dist);
            fs.writeFileSync(
                path.join(dist, 'TestModule.js'),
                `export class TestModule {
                    static initManifest(m) {
                        m.description = Object.keys(m.configSchema.properties).join(',');
                    }
                }`,
            );
            const registry = new PluginRegistry(tmpDir);
            await registry.init();
            expect(registry.find('net')!.description).toBe(
                'port,ingestOffsetMs,pidTrimsMs,smoothingCooldownMin',
            );

            const mod: Record<string, unknown> = { pluginId: 'net' };
            registry.overlayManifest(mod);
            expect((mod.configSchema as any).properties.pidTrimsMs).toEqual(TRIMS);
        });
    });

    describe('refresh', () => {
        it('clears cache so next getAll rescans', () => {
            createPlugin('plugin-a', {
                pluginId: 'a',
                displayName: 'A',
                ports: [],
                configSchema: {},
            });

            const registry = new PluginRegistry(tmpDir);
            expect(registry.getAll()).toHaveLength(1);

            // Add another plugin
            createPlugin('plugin-b', {
                pluginId: 'b',
                displayName: 'B',
                ports: [],
                configSchema: {},
            });

            // Still cached
            expect(registry.getAll()).toHaveLength(1);

            // After refresh, rescans
            registry.refresh();
            expect(registry.getAll()).toHaveLength(2);
        });
    });

    describe('init', () => {
        it('calls static initManifest on engine module class', async () => {
            const pluginDir = path.join(tmpDir, 'test-plugin');
            fs.mkdirSync(path.join(pluginDir, 'dist'), { recursive: true });

            fs.writeFileSync(
                path.join(pluginDir, 'package.json'),
                JSON.stringify({
                    name: '@test/test-plugin',
                    version: '1.0.0',
                    mediaRouter: {
                        pluginId: 'test-plugin',
                        displayName: 'Test Plugin',
                        engine: './engine/TestModule.ts',
                        ports: [],
                        configSchema: {},
                    },
                }),
            );

            // Write a JS module with initManifest
            fs.writeFileSync(
                path.join(pluginDir, 'dist', 'TestModule.js'),
                `export class TestModule {
                    static async initManifest(manifest) {
                        manifest.description = 'initialized';
                    }
                }`,
            );

            const registry = new PluginRegistry(tmpDir);
            await registry.init();

            const plugin = registry.find('test-plugin');
            expect(plugin).toBeDefined();
            expect(plugin!.description).toBe('initialized');
        });

        it('skips plugins without engine file in manifest', async () => {
            createPlugin('no-engine', {
                pluginId: 'no-engine',
                displayName: 'No Engine',
                ports: [],
                configSchema: {},
            });

            const registry = new PluginRegistry(tmpDir);
            // Should not throw
            await registry.init();
            expect(registry.find('no-engine')).toBeDefined();
        });
    });

    describe('edge cases', () => {
        it('handles missing plugins directory gracefully', () => {
            const registry = new PluginRegistry('/nonexistent/path');
            const plugins = registry.getAll();
            expect(plugins).toEqual([]);
        });

        it('skips directories without package.json', () => {
            fs.mkdirSync(path.join(tmpDir, 'no-pkg'));
            const registry = new PluginRegistry(tmpDir);
            expect(registry.getAll()).toEqual([]);
        });

        it('skips packages without mediaRouter field', () => {
            const pluginDir = path.join(tmpDir, 'no-manifest');
            fs.mkdirSync(pluginDir);
            fs.writeFileSync(
                path.join(pluginDir, 'package.json'),
                JSON.stringify({ name: 'test', version: '1.0.0' }),
            );

            const registry = new PluginRegistry(tmpDir);
            expect(registry.getAll()).toEqual([]);
        });

        it('skips non-directory entries', () => {
            // Create a file (not directory) in the plugins dir
            fs.writeFileSync(path.join(tmpDir, 'not-a-dir.txt'), 'hello');
            const registry = new PluginRegistry(tmpDir);
            expect(registry.getAll()).toEqual([]);
        });

        it('skips directories with invalid JSON in package.json', () => {
            const pluginDir = path.join(tmpDir, 'bad-json');
            fs.mkdirSync(pluginDir);
            fs.writeFileSync(path.join(pluginDir, 'package.json'), '{invalid json}');

            const registry = new PluginRegistry(tmpDir);
            expect(registry.getAll()).toEqual([]);
        });
    });
});
