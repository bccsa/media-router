import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PluginLoader } from './PluginLoader.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('PluginLoader', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-plugin-test-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function createPlugin(name: string, manifest: Record<string, unknown>, engineCode?: string): void {
        const pluginDir = path.join(tmpDir, name);
        fs.mkdirSync(pluginDir, { recursive: true });

        const pkg: any = { name: `@test/${name}`, version: '1.0.0' };
        if (manifest) pkg.mediaRouter = manifest;
        fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify(pkg));

        if (engineCode) {
            const engineDir = path.join(pluginDir, 'engine');
            fs.mkdirSync(engineDir, { recursive: true });
            fs.writeFileSync(path.join(engineDir, 'TestModule.js'), engineCode);
        }
    }

    it('returns 0 for nonexistent plugins directory', () => {
        const loader = new PluginLoader('/nonexistent/path');
        expect(loader.load()).toBe(0);
        expect(loader.size).toBe(0);
    });

    it('returns 0 for empty directory', () => {
        const loader = new PluginLoader(tmpDir);
        expect(loader.load()).toBe(0);
    });

    it('skips directories without package.json', () => {
        fs.mkdirSync(path.join(tmpDir, 'no-pkg'));
        const loader = new PluginLoader(tmpDir);
        expect(loader.load()).toBe(0);
    });

    it('skips packages without mediaRouter manifest', () => {
        createPlugin('no-manifest', undefined as any);
        // Write a package.json without mediaRouter
        fs.writeFileSync(
            path.join(tmpDir, 'no-manifest', 'package.json'),
            JSON.stringify({ name: 'test', version: '1.0.0' }),
        );
        const loader = new PluginLoader(tmpDir);
        expect(loader.load()).toBe(0);
    });

    it('skips manifests missing required fields', () => {
        createPlugin('bad-manifest', { pluginId: 'test' }); // missing displayName and engine
        const loader = new PluginLoader(tmpDir);
        expect(loader.load()).toBe(0);
    });

    it('loads a valid plugin manifest', () => {
        createPlugin('good', {
            pluginId: 'test-plugin',
            displayName: 'Test Plugin',
            engine: './engine/TestModule.js',
            ports: [],
        });

        const loader = new PluginLoader(tmpDir);
        expect(loader.load()).toBe(1);
        expect(loader.size).toBe(1);

        const plugin = loader.get('test-plugin');
        expect(plugin).toBeDefined();
        expect(plugin!.manifest.pluginId).toBe('test-plugin');
        expect(plugin!.manifest.displayName).toBe('Test Plugin');
    });

    it('loads multiple plugins', () => {
        createPlugin('plugin-a', {
            pluginId: 'a',
            displayName: 'Plugin A',
            engine: './engine/TestModule.js',
        });
        createPlugin('plugin-b', {
            pluginId: 'b',
            displayName: 'Plugin B',
            engine: './engine/TestModule.js',
        });

        const loader = new PluginLoader(tmpDir);
        expect(loader.load()).toBe(2);
        expect(loader.get('a')).toBeDefined();
        expect(loader.get('b')).toBeDefined();
    });

    it('returns undefined for unknown plugin', () => {
        const loader = new PluginLoader(tmpDir);
        loader.load();
        expect(loader.get('nonexistent')).toBeUndefined();
    });

    it('getManifests returns all loaded manifests', () => {
        createPlugin('p1', { pluginId: 'p1', displayName: 'P1', engine: './engine/T.js' });
        createPlugin('p2', { pluginId: 'p2', displayName: 'P2', engine: './engine/T.js' });

        const loader = new PluginLoader(tmpDir);
        loader.load();

        const manifests = loader.getManifests();
        expect(manifests).toHaveLength(2);
        expect(manifests.map((m) => m.pluginId).sort()).toEqual(['p1', 'p2']);
    });

    it('clears previous plugins on reload', () => {
        createPlugin('first', { pluginId: 'first', displayName: 'First', engine: './engine/T.js' });

        const loader = new PluginLoader(tmpDir);
        loader.load();
        expect(loader.size).toBe(1);

        // Remove the plugin and reload
        fs.rmSync(path.join(tmpDir, 'first'), { recursive: true });
        loader.load();
        expect(loader.size).toBe(0);
    });

    it('defaults missing ports and configSchema', () => {
        createPlugin('minimal', {
            pluginId: 'min',
            displayName: 'Minimal',
            engine: './engine/T.js',
            // no ports or configSchema
        });

        const loader = new PluginLoader(tmpDir);
        loader.load();

        const plugin = loader.get('min');
        expect(plugin!.manifest.ports).toEqual([]);
        expect(plugin!.manifest.configSchema).toEqual({});
    });

    it('loads engine module class when JS file exists', () => {
        const engineCode = `
            class TestModule {
                onInit() {}
                onStart() {}
                onStop() {}
            }
            module.exports = { TestModule };
        `;
        createPlugin('with-class', {
            pluginId: 'with-class',
            displayName: 'With Class',
            engine: './engine/TestModule.js',
        }, engineCode);

        const loader = new PluginLoader(tmpDir);
        loader.load();

        const plugin = loader.get('with-class');
        expect(plugin).toBeDefined();
        expect(plugin!.ModuleClass).toBeDefined();
        expect(typeof plugin!.ModuleClass).toBe('function');
    });

    it('skips unsupported architecture', () => {
        createPlugin('wrong-arch', {
            pluginId: 'wrong-arch',
            displayName: 'Wrong Arch',
            engine: './engine/T.js',
            architectures: ['sparc64'], // definitely not our arch
        });

        const loader = new PluginLoader(tmpDir);
        expect(loader.load()).toBe(0);
    });
});
