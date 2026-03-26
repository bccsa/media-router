import * as fs from 'fs';
import * as path from 'path';
import type { PluginManifest } from '@media-router/shared-types';
import { createLogger } from '@media-router/shared-types';
import type { PluginModule } from './PluginModule.js';

const log = createLogger('PluginLoader');

export interface LoadedPlugin {
    manifest: PluginManifest;
    ModuleClass: (new () => PluginModule) | null;
}

/**
 * Discovers and loads plugins from the plugins/ directory.
 *
 * Scans each subdirectory for a package.json with a `mediaRouter` manifest.
 * Validates the manifest, filters by current architecture, and dynamically
 * loads the engine module class.
 */
export class PluginLoader {
    private plugins = new Map<string, LoadedPlugin>();
    private pluginsDir: string;

    constructor(pluginsDir?: string) {
        // Default: <root>/plugins/ relative to engine src or dist
        // From packages/engine/src/plugins/: ../../../../plugins = <root>/plugins/
        this.pluginsDir = pluginsDir ?? path.resolve(__dirname, '../../../../plugins');
    }

    /** Discover and load all valid plugins. Returns count of loaded plugins. */
    async load(): Promise<number> {
        this.plugins.clear();

        if (!fs.existsSync(this.pluginsDir)) {
            log.warn({ pluginsDir: this.pluginsDir }, 'Plugins directory not found');
            return 0;
        }

        const entries = fs.readdirSync(this.pluginsDir, { withFileTypes: true });
        const currentArch = process.arch === 'arm64' ? 'arm64' : 'x86_64';

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;

            const pluginDir = path.join(this.pluginsDir, entry.name);
            const pkgPath = path.join(pluginDir, 'package.json');

            if (!fs.existsSync(pkgPath)) continue;

            try {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
                const manifest = pkg.mediaRouter as PluginManifest | undefined;

                if (!manifest) continue;

                // Validate required fields
                if (!manifest.pluginId || !manifest.displayName || !manifest.engine) {
                    log.warn({ plugin: entry.name }, 'Invalid manifest: missing required fields');
                    continue;
                }

                // Filter by architecture
                if (manifest.architectures && !manifest.architectures.includes(currentArch)) {
                    log.info({ pluginId: manifest.pluginId, arch: currentArch }, 'Skipping plugin: not supported on architecture');
                    continue;
                }

                // Ensure ports is an array
                if (!manifest.ports) manifest.ports = [];
                if (!manifest.configSchema) manifest.configSchema = {};

                // Try to load the engine module class via dynamic import()
                let ModuleClass: (new () => PluginModule) | null = null;
                try {
                    const enginePath = path.resolve(pluginDir, manifest.engine);
                    // Try .ts first (tsx dev mode), then .js (compiled), then dist/ .js
                    const tsPath = enginePath;
                    const jsPath = enginePath.replace(/\.ts$/, '.js');
                    const distJsPath = path.join(pluginDir, 'dist', path.basename(manifest.engine).replace(/\.ts$/, '.js'));

                    let mod: any;
                    for (const tryPath of [tsPath, jsPath, distJsPath]) {
                        if (fs.existsSync(tryPath)) {
                            mod = await import(tryPath);
                            break;
                        }
                    }

                    if (mod) {
                        // Find the exported class (first export that's a constructor)
                        const exportedClass = Object.values(mod).find(
                            (v) => typeof v === 'function' && v.prototype,
                        ) as (new () => PluginModule) | undefined;
                        if (exportedClass) ModuleClass = exportedClass;
                    }
                } catch (err) {
                    log.warn({ err, pluginId: manifest.pluginId }, 'Could not load engine module');
                }

                this.plugins.set(manifest.pluginId, {
                    manifest,
                    ModuleClass,
                });

                log.info({ pluginId: manifest.pluginId, displayName: manifest.displayName, hasEngineClass: !!ModuleClass }, 'Loaded plugin');
            } catch (err) {
                log.warn({ err, plugin: entry.name }, 'Failed to load plugin');
            }
        }

        return this.plugins.size;
    }

    /** Get a loaded plugin by ID. */
    get(pluginId: string): LoadedPlugin | undefined {
        return this.plugins.get(pluginId);
    }

    /** Get all loaded plugin manifests. */
    getManifests(): PluginManifest[] {
        return Array.from(this.plugins.values()).map((p) => p.manifest);
    }

    /** Get the number of loaded plugins. */
    get size(): number {
        return this.plugins.size;
    }
}
