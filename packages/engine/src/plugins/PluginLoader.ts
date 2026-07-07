import * as fs from 'fs';
import * as path from 'path';
import type { PluginManifest } from '@media-router/shared-types';
import { createLogger } from '@media-router/shared-types';
import type { PluginConstructor, EngineServices } from './PluginModule.js';

const log = createLogger('PluginLoader');

export interface LoadedPlugin {
    manifest: PluginManifest;
    ModuleClass: PluginConstructor | null;
}

/**
 * Type guard for the runtime shape of a plugin class. We rely on prototype
 * methods rather than `instanceof PluginModule` because each plugin builds
 * against its own copy of `@media-router/engine` and an `instanceof` check
 * across copies would always fail.
 */
function isPluginConstructor(v: unknown): v is PluginConstructor {
    if (typeof v !== 'function') return false;
    const proto = (v as { prototype?: Record<string, unknown> }).prototype;
    return typeof proto?.onInit === 'function' && typeof proto?.onStart === 'function';
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

    /** Discover and load all valid plugins. If `services` is passed, each plugin's static `registerServices` runs once after `initManifest`. */
    async load(services?: EngineServices): Promise<number> {
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
                    log.info(
                        { pluginId: manifest.pluginId, arch: currentArch },
                        'Skipping plugin: not supported on architecture',
                    );
                    continue;
                }

                // Ensure ports is an array
                if (!manifest.ports) manifest.ports = [];
                if (!manifest.configSchema) manifest.configSchema = {};

                // Try to load the engine module class via dynamic import()
                // Each plugin is isolated — one bad import doesn't break others
                let ModuleClass: PluginConstructor | null = null;
                const enginePath = path.resolve(pluginDir, manifest.engine);
                const tsPath = enginePath;
                const jsPath = enginePath.replace(/\.ts$/, '.js');
                const distJsPath = path.join(
                    pluginDir,
                    'dist',
                    path.basename(manifest.engine).replace(/\.ts$/, '.js'),
                );

                let mod: Record<string, unknown> | undefined;
                for (const tryPath of [distJsPath, jsPath, tsPath]) {
                    if (!fs.existsSync(tryPath)) continue;
                    try {
                        mod = await import(tryPath);
                        break;
                    } catch (err) {
                        log.error(
                            { err, pluginId: manifest.pluginId, path: tryPath },
                            'Plugin import failed',
                        );
                    }
                }

                if (mod) {
                    const exportedClass = Object.values(mod).find(isPluginConstructor);
                    if (exportedClass) {
                        ModuleClass = exportedClass;
                        if (exportedClass.initManifest) {
                            try {
                                await exportedClass.initManifest(manifest);
                            } catch (err) {
                                log.warn(
                                    { err, pluginId: manifest.pluginId },
                                    'initManifest failed',
                                );
                            }
                        }
                        if (services && exportedClass.registerServices) {
                            try {
                                await exportedClass.registerServices(services);
                            } catch (err) {
                                log.warn(
                                    { err, pluginId: manifest.pluginId },
                                    'registerServices failed',
                                );
                            }
                        }
                    }
                }

                this.plugins.set(manifest.pluginId, {
                    manifest,
                    ModuleClass,
                });

                log.info(
                    {
                        pluginId: manifest.pluginId,
                        displayName: manifest.displayName,
                        hasEngineClass: !!ModuleClass,
                    },
                    'Loaded plugin',
                );
            } catch (err) {
                log.error({ err, plugin: entry.name }, 'Failed to load plugin — skipping');
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

    /**
     * Effective config schemas per plugin id, as narrowed by each plugin's
     * `initManifest` for THIS host (e.g. the encoder probe drops impls the box
     * can't honour). Sent to the manager on connect so it renders each engine's
     * real capabilities rather than falling back to its own host probe.
     */
    getPluginSchemas(): Record<string, unknown> {
        const schemas: Record<string, unknown> = {};
        for (const [pluginId, p] of this.plugins) {
            schemas[pluginId] = p.manifest.configSchema;
        }
        return schemas;
    }

    /** Get the number of loaded plugins. */
    get size(): number {
        return this.plugins.size;
    }
}
