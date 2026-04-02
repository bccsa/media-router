import * as fs from 'fs';
import * as path from 'path';

export interface PluginManifest {
    pluginId: string;
    displayName: string;
    description?: string;
    category?: string;
    color?: string;
    icon?: string;
    ports: Array<Record<string, unknown>>;
    configSchema: Record<string, unknown>;
    statusSections?: Array<Record<string, unknown>>;
    faceWidgets?: Array<Record<string, unknown>>;
}

/**
 * Scans the plugins directory and returns manifest data for each valid plugin.
 * Results are cached after first scan. Call refresh() to re-scan.
 */
export class PluginRegistry {
    private pluginsDir: string;
    private cache: PluginManifest[] | null = null;

    constructor(pluginsDir?: string) {
        this.pluginsDir = pluginsDir ?? path.resolve(__dirname, '../../../../plugins');
    }

    /** Get all plugins (cached after first call). */
    getAll(): PluginManifest[] {
        if (this.cache) return this.cache;
        this.cache = this.scan();
        return this.cache;
    }

    /** Load engine module classes and call static initManifest() to detect runtime capabilities. */
    async init(): Promise<void> {
        const plugins = this.getAll();
        for (const plugin of plugins) {
            try {
                const pluginDir = path.join(this.pluginsDir, plugin.pluginId);
                const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf-8'));
                const engineFile = pkg.mediaRouter?.engine;
                if (!engineFile) continue;

                const enginePath = path.resolve(pluginDir, engineFile);
                const distJsPath = path.join(pluginDir, 'dist', path.basename(engineFile).replace(/\.ts$/, '.js'));
                const jsPath = enginePath.replace(/\.ts$/, '.js');

                let mod: any;
                for (const tryPath of [distJsPath, jsPath, enginePath]) {
                    if (fs.existsSync(tryPath)) {
                        mod = await import(tryPath);
                        break;
                    }
                }
                if (!mod) continue;

                const cls = Object.values(mod).find((v) => typeof v === 'function' && v.prototype) as any;
                if (cls?.initManifest) {
                    await cls.initManifest(plugin);
                }
            } catch {
                // Skip — initManifest is optional
            }
        }
    }

    /** Find a specific plugin by ID. */
    find(pluginId: string): PluginManifest | undefined {
        return this.getAll().find((p) => p.pluginId === pluginId);
    }

    /** Force re-scan of the plugins directory. */
    refresh(): void {
        this.cache = null;
    }

    private scan(): PluginManifest[] {
        if (!fs.existsSync(this.pluginsDir)) return [];

        const plugins: PluginManifest[] = [];
        const entries = fs.readdirSync(this.pluginsDir, { withFileTypes: true });

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const pkgPath = path.join(this.pluginsDir, entry.name, 'package.json');
            if (!fs.existsSync(pkgPath)) continue;

            try {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
                if (pkg.mediaRouter) {
                    plugins.push({
                        pluginId: pkg.mediaRouter.pluginId,
                        displayName: pkg.mediaRouter.displayName,
                        description: pkg.mediaRouter.description,
                        category: pkg.mediaRouter.category,
                        color: pkg.mediaRouter.color,
                        icon: pkg.mediaRouter.icon,
                        ports: pkg.mediaRouter.ports ?? [],
                        configSchema: pkg.mediaRouter.configSchema ?? {},
                        statusSections: pkg.mediaRouter.statusSections,
                        faceWidgets: pkg.mediaRouter.faceWidgets,
                    });
                }
            } catch {
                // Skip invalid plugins
            }
        }
        return plugins;
    }
}
