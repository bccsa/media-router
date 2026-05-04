import type { EngineState, InterlockState, ModuleState } from '@/stores/engines';

/**
 * Default accent colour for interlock badges — picked to differ from stream
 * colours (blue audio, orange mpegts, green video) and accent green.
 */
export const INTERLOCK_DEFAULT_COLOR = '#a855f7';

/**
 * True if this module's plugin opts into interlocks (has `interlock: true` in
 * its manifest). Membership forms are only offered for eligible modules.
 */
export function isInterlockEligible(mod: ModuleState | undefined): boolean {
    return mod?.interlock === true;
}

// Per-engine moduleId → interlock lookup cache. Keyed by a snapshot of the
// interlocks array, so when the array reference changes we rebuild.
const interlockIndexCache = new WeakMap<readonly InterlockState[], Map<string, InterlockState>>();

function interlockIndex(
    interlocks: readonly InterlockState[] | undefined,
): Map<string, InterlockState> {
    if (!interlocks || !Array.isArray(interlocks)) return new Map();
    const cached = interlockIndexCache.get(interlocks);
    if (cached) return cached;
    const map = new Map<string, InterlockState>();
    for (const g of interlocks) {
        if (!Array.isArray(g?.members)) continue;
        for (const id of g.members) map.set(id, g);
    }
    interlockIndexCache.set(interlocks, map);
    return map;
}

/** O(1) lookup of the interlock (if any) that a module belongs to. */
export function getInterlockForModule(
    engine: EngineState | undefined,
    moduleId: string,
): InterlockState | undefined {
    return interlockIndex(engine?.interlocks).get(moduleId);
}

/** The currently-unmuted member of an interlock, or undefined if none. */
export function getHotMember(
    engine: EngineState | undefined,
    ilk: InterlockState,
): ModuleState | undefined {
    if (!engine) return undefined;
    for (const id of ilk.members) {
        const mod = engine.modules[id];
        if (!mod) continue;
        const on = mod.settings?.audioEnabled;
        if (on !== false) return mod;
    }
    return undefined;
}

/**
 * Preview: if the user unmutes `moduleId` now, which other members will be
 * auto-muted? Empty list = no auto-mute side effect.
 */
export function willMuteOnUnmute(engine: EngineState | undefined, moduleId: string): ModuleState[] {
    const ilk = getInterlockForModule(engine, moduleId);
    if (!engine || !ilk) return [];
    const out: ModuleState[] = [];
    for (const other of ilk.members) {
        if (other === moduleId) continue;
        const mod = engine.modules[other];
        if (!mod) continue;
        if (mod.settings?.audioEnabled !== false) out.push(mod);
    }
    return out;
}

/** Short unique interlock id. */
export function newInterlockId(): string {
    return `ilk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Pick a black-or-white foreground colour that reads against the given
 * background. Used for badges filled with a user-picked interlock colour,
 * where light hex values would otherwise hide light text. YIQ heuristic —
 * cheap and good enough for solid colour swatches.
 */
export function readableTextOn(bg: string | undefined): string {
    const hex = (bg ?? '').replace('#', '').trim();
    const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
    if (full.length !== 6 || !/^[0-9a-f]{6}$/i.test(full)) return '#ffffff';
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    const yiq = (r * 299 + g * 587 + b * 114) / 1000;
    return yiq >= 140 ? '#0f1117' : '#ffffff';
}
