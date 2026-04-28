/**
 * Resolve any Lucide icon by manifest name without per-icon core edits and
 * without bundling the whole icon library upfront.
 *
 * Each icon file in `lucide-vue-next/dist/esm/icons/<kebab>.js` is its own
 * ~1 KB module. `import.meta.glob` makes Vite generate a code-split chunk
 * per file at build time; only icons actually referenced via `getLucideIcon`
 * download at runtime. Plugins keep the "set `icon: "<name>"` and you're
 * done" property, and the manager-UI doesn't ship 1,500 icons it never uses.
 */
import { defineAsyncComponent, markRaw, type Component } from 'vue';

const iconLoaders = import.meta.glob('/node_modules/lucide-vue-next/dist/esm/icons/*.js');

const iconCache = new Map<string, Component | null>();

/** Resolve a Lucide icon component by kebab-case name (e.g. "volume-2" → Volume2). */
export function getLucideIcon(name?: string): Component | null {
    if (!name) return null;
    if (iconCache.has(name)) return iconCache.get(name) ?? null;

    const path = `/node_modules/lucide-vue-next/dist/esm/icons/${name}.js`;
    const loader = iconLoaders[path];
    if (!loader) {
        iconCache.set(name, null);
        return null;
    }

    const cmp = markRaw(
        defineAsyncComponent({
            loader: async () => {
                const mod = (await loader()) as { default: Component };
                return mod.default;
            },
            // No flicker on load (icons are tiny, mostly cache-hits).
            delay: 0,
            errorComponent: { render: () => null } as Component,
        }),
    );
    iconCache.set(name, cmp);
    return cmp;
}
