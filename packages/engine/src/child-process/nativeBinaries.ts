import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '@media-router/shared-types';

const log = createLogger('nativeAssets');

/**
 * Resolution of native helper binaries and python assets shipped inside
 * plugin folders (`plugins/<plugin>/native/<tool>/`, `plugins/<plugin>/py/`).
 *
 * Scoping rule: the requesting plugin's own folder always wins, so two
 * plugins may ship a tool with the same name without conflict. Only a lookup
 * that falls through to the cross-plugin scan can be ambiguous — that case
 * fails loud (error log naming every match, `null` returned) instead of
 * silently picking one.
 *
 * `MR_NATIVE_BIN_DIR`, when set, is AUTHORITATIVE for binaries (a dev
 * override that silently fell back would defeat its purpose).
 * `MR_PLUGINS_DIR` overrides the plugins root (tests / unusual layouts).
 */

/** Packaged install root (`make native-install` → Yocto image). */
function installedRoot(): string {
    return process.env.MR_LIBEXEC_DIR ?? '/usr/libexec/media-router';
}

/** Repo/deployed plugins root — works from src (tsx/vitest) and dist. */
function pluginsRoot(): string {
    // src/child-process or dist/child-process -> packages/engine -> repo root
    return process.env.MR_PLUGINS_DIR ?? join(__dirname, '../../../..', 'plugins');
}

function pluginDirNames(root: string): string[] {
    try {
        return readdirSync(root, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name)
            .sort();
    } catch {
        return [];
    }
}

/**
 * Collect cross-plugin matches for a relative path, keyed by plugin name so
 * the same plugin seen via both the installed tree and the repo tree counts
 * once (installed path preferred). ≥2 distinct plugins → ambiguous.
 */
function scanPlugins(candidatesFor: (plugin: string, root: string) => string): Map<string, string> {
    const matches = new Map<string, string>();
    for (const plugin of pluginDirNames(installedRoot())) {
        const p = candidatesFor(plugin, installedRoot());
        if (existsSync(p)) matches.set(plugin, p);
    }
    const repo = pluginsRoot();
    for (const plugin of pluginDirNames(repo)) {
        const p = candidatesFor(plugin, repo);
        if (!matches.has(plugin) && existsSync(p)) matches.set(plugin, p);
    }
    return matches;
}

function pickUnambiguous(name: string, matches: Map<string, string>): string | null {
    if (matches.size === 0) return null;
    if (matches.size > 1) {
        log.error(
            { name, matches: Object.fromEntries(matches) },
            'Ambiguous native asset — multiple plugins ship this name; pass the owning pluginId or rename',
        );
        return null;
    }
    return matches.values().next().value ?? null;
}

/**
 * Locate a native helper binary (e.g. mr-tssplit, mr-bus-fanout — built by
 * `make native`). Order: `MR_NATIVE_BIN_DIR` (authoritative) → the calling
 * plugin's own folder → cross-plugin scan of the installed tree
 * (`/usr/libexec/media-router/<plugin>/<name>`) and the repo tree
 * (`plugins/<plugin>/native/<name>/<name>`). Returns null when nothing is
 * found — callers surface a health error pointing at plugins/README.md.
 */
export function resolveNativeBinary(name: string, pluginId?: string): string | null {
    if (process.env.MR_NATIVE_BIN_DIR) {
        const p = join(process.env.MR_NATIVE_BIN_DIR, name);
        return existsSync(p) ? p : null;
    }
    if (pluginId) {
        for (const p of [
            join(pluginsRoot(), pluginId, 'native', name, name),
            join(installedRoot(), pluginId, name),
        ]) {
            if (existsSync(p)) return p;
        }
    }
    const matches = scanPlugins((plugin, root) =>
        root === installedRoot()
            ? join(root, plugin, name)
            : join(root, plugin, 'native', name, name),
    );
    return pickUnambiguous(name, matches);
}

/**
 * Locate a python sidecar script shipped in a plugin's `py/` folder. Same
 * scoping as `resolveNativeBinary` (own plugin first, ambiguous scan fails
 * loud). The plugins tree ships verbatim to the image, so one path scheme
 * covers dev checkouts and installed systems.
 */
export function resolvePythonScript(name: string, pluginId?: string): string | null {
    if (pluginId) {
        const own = join(pluginsRoot(), pluginId, 'py', name);
        if (existsSync(own)) return own;
    }
    const matches = new Map<string, string>();
    const root = pluginsRoot();
    for (const plugin of pluginDirNames(root)) {
        const p = join(root, plugin, 'py', name);
        if (existsSync(p)) matches.set(plugin, p);
    }
    return pickUnambiguous(name, matches);
}

/**
 * Every existing `plugins/<plugin>/py` directory (sorted) — appended to the
 * gst runner's PYTHONPATH so pipeline code can `import` plugin-owned python
 * modules regardless of which folder ships them.
 */
export function pluginPythonPaths(): string[] {
    const root = pluginsRoot();
    return pluginDirNames(root)
        .map((plugin) => join(root, plugin, 'py'))
        .filter((p) => existsSync(p));
}

/**
 * Python has one flat import namespace per process, so runner-imported module
 * filenames must be unique across all plugin `py/` dirs. Startup check: log
 * an error naming every clash (the engine keeps running — only the clashing
 * imports are at risk).
 */
export function warnDuplicatePyModules(): void {
    const owners = new Map<string, string[]>();
    for (const dir of pluginPythonPaths()) {
        for (const f of readdirSync(dir)) {
            if (!f.endsWith('.py')) continue;
            owners.set(f, [...(owners.get(f) ?? []), join(dir, f)]);
        }
    }
    for (const [file, paths] of owners) {
        if (paths.length > 1) {
            log.error(
                { file, paths },
                'Duplicate python module across plugin py/ dirs — imports are ambiguous, rename one',
            );
        }
    }
}
