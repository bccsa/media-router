import type { Component } from 'vue';

/**
 * Build-time registry of plugin-provided face components.
 *
 * Any plugin can drop a `ui/NodeFace.vue` into its directory; Vite scans the
 * glob below at build time and bundles it. At runtime, `getFaceComponent`
 * looks up by `pluginId` so `ModuleNode` can render the plugin's own face.
 *
 * Component contract:
 *   - Accepts a single `module` prop of type `ModuleState` (import from
 *     `@/stores/engines`). No emits — the component is a pure view.
 *   - Rendered inside the node card, between the header and the port labels.
 *     Styling that fits within a 200px-wide card is up to the plugin.
 */
const eagerModules = import.meta.glob<{ default: Component }>(
    '../../../../plugins/*/ui/NodeFace.vue',
    { eager: true },
);

const FACE_COMPONENTS: Record<string, Component> = {};
for (const [path, mod] of Object.entries(eagerModules)) {
    const match = path.match(/plugins\/([^/]+)\/ui\/NodeFace\.vue$/);
    if (match) FACE_COMPONENTS[match[1]] = mod.default;
}

export function getFaceComponent(pluginId: string | undefined): Component | null {
    if (!pluginId) return null;
    return FACE_COMPONENTS[pluginId] ?? null;
}
