import * as fs from 'fs';
import * as path from 'path';
import type { ResizableBounds } from '@media-router/shared-types';

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
    /** Module is eligible for interlock (exclusive-mute) groups. */
    interlock?: boolean;
    /** User can resize the module card. `true` for defaults, object for bounds. */
    resizable?: boolean | ResizableBounds;
}

/**
 * Runtime shape of a plugin class as seen from the manager side: we only ever
 * call `initManifest` here. (The engine side has its own typed surface that
 * also includes `registerServices`.)
 */
interface PluginClass {
    initManifest?(manifest: PluginManifest): void | Promise<void>;
}

/**
 * Heuristic — is this exported value a class (or class-like constructor)?
 *
 * The manager doesn't need the full plugin contract that the engine enforces
 * (`onInit` + `onStart` instance methods on the prototype); it only needs
 * something it can probe for an optional static `initManifest`. So this
 * accepts any function with a prototype object — narrower checks would
 * exclude legitimate plugin classes that omit `initManifest`.
 */
function isClassLike(v: unknown): v is PluginClass {
    return (
        typeof v === 'function' &&
        typeof (v as { prototype?: unknown }).prototype === 'object' &&
        (v as { prototype: object }).prototype !== null
    );
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
                const pkg = JSON.parse(
                    fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf-8'),
                );
                const engineFile = pkg.mediaRouter?.engine;
                if (!engineFile) continue;

                const enginePath = path.resolve(pluginDir, engineFile);
                const distJsPath = path.join(
                    pluginDir,
                    'dist',
                    path.basename(engineFile).replace(/\.ts$/, '.js'),
                );
                const jsPath = enginePath.replace(/\.ts$/, '.js');

                let mod: Record<string, unknown> | undefined;
                for (const tryPath of [distJsPath, jsPath, enginePath]) {
                    if (fs.existsSync(tryPath)) {
                        mod = await import(tryPath);
                        break;
                    }
                }
                if (!mod) continue;

                const cls = Object.values(mod).find(isClassLike);
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

    /**
     * Mutate `mod` in place, overlaying manifest-derived fields. Single point
     * of truth — used by both the initial `engine:list` snapshot and the
     * `engine:update` add-module enrichment so they can't drift (a missing
     * field here is exactly what made freshly-added resizable plugins
     * un-resizable until refresh).
     *
     * Static-port plugins are authoritative for `ports`; dynamic-port plugins
     * (manifest.ports empty, e.g. n1-mixer) keep whatever the engine pushed.
     */
    overlayManifest(mod: Record<string, unknown>): void {
        const manifest = this.find(mod.pluginId as string);
        if (!manifest) return;
        if ((manifest.ports ?? []).length > 0) mod.ports = manifest.ports;
        mod.configSchema = manifest.configSchema ?? {};
        mod.color = manifest.color;
        mod.icon = manifest.icon;
        mod.statusSections = manifest.statusSections;
        mod.faceWidgets = manifest.faceWidgets;
        mod.interlock = manifest.interlock === true;
        mod.resizable = manifest.resizable ?? false;
    }

    /**
     * Stamp identity + runtime defaults + manifest fields onto a raw module
     * value, mutating in place. Single point of truth for "make a raw module
     * shape broadcast-ready" — used by both `add /modules/<id>` (PatchRouter)
     * and `replace /modules` (profile activate). Defaults only fill missing
     * fields so stored per-module state (user toggles, enabled flag, etc.)
     * survives unchanged.
     */
    enrichModule(id: string, mod: Record<string, unknown>): void {
        mod.instanceId = id;
        if (mod.enabled === undefined) mod.enabled = true;
        if (mod.running === undefined) mod.running = false;
        if (mod.health === undefined) mod.health = 'stopped';
        if (mod.pendingRestart === undefined) mod.pendingRestart = false;
        this.overlayManifest(mod);
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
                        interlock: pkg.mediaRouter.interlock === true,
                        resizable: pkg.mediaRouter.resizable,
                    });
                }
            } catch {
                // Skip invalid plugins
            }
        }
        return plugins;
    }
}
