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
