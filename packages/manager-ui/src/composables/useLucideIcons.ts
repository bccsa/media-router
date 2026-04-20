/**
 * Curated map of Lucide icons used by plugins.
 * Avoids importing the entire lucide-vue-next library (1.1MB → ~5KB).
 * Add new icons here as plugins reference them via the "icon" manifest field.
 */
import {
    ArrowDownToLine,
    ArrowUpFromLine,
    Download,
    Mic,
    Radio,
    RadioTower,
    Shuffle,
    Upload,
    Volume2,
} from 'lucide-vue-next';
import type { Component } from 'vue';

const iconMap: Record<string, Component> = {
    ArrowDownToLine,
    ArrowUpFromLine,
    Download,
    Mic,
    Radio,
    RadioTower,
    Shuffle,
    Upload,
    Volume2,
};

/** Resolve a Lucide icon component by kebab-case name (e.g. "volume-2" → Volume2). */
export function getLucideIcon(name?: string): Component | null {
    if (!name) return null;
    const pascal = name.replace(/(^|-)([a-z0-9])/g, (_: string, __: string, c: string) =>
        c.toUpperCase(),
    );
    return iconMap[pascal] ?? null;
}
