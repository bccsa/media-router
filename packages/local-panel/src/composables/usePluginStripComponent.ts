import type { Component } from 'vue';

/**
 * Build-time registry of plugin-provided LCP strip components.
 *
 * A plugin wanting to render something other than the default `MixerStrip`
 * drops a `ui/LcpStrip.vue` into its directory. Vite scans the glob at build
 * time and bundles it. At runtime `getStripComponent(pluginId)` looks up the
 * plugin's component; if there's none, the caller falls back to the default
 * mixer strip.
 *
 * Component contract:
 *   - Single `module` prop of type `LcpModuleState`.
 *   - Responsible for its own layout within a ~120px-wide mixer-row cell.
 *   - Emits are the same as MixerStrip (`volume`, `mute`); plugins can
 *     ignore them if they don't apply.
 */
const eagerModules = import.meta.glob<{ default: Component }>(
    '../../../../plugins/*/ui/LcpStrip.vue',
    { eager: true },
);

const STRIP_COMPONENTS: Record<string, Component> = {};
for (const [path, mod] of Object.entries(eagerModules)) {
    const match = path.match(/plugins\/([^/]+)\/ui\/LcpStrip\.vue$/);
    if (match) STRIP_COMPONENTS[match[1]] = mod.default;
}

export function getStripComponent(pluginId: string | undefined): Component | null {
    if (!pluginId) return null;
    return STRIP_COMPONENTS[pluginId] ?? null;
}
