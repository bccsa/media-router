import type { PatchOp } from '@media-router/shared-types';

type Settings = Record<string, unknown>;

/**
 * The value each module setting held before `ops` write it, per module id.
 * Call it BEFORE the patch is applied.
 *
 * The router applies a patch to the engine config before it runs the side
 * effects, and each module instance (and its plugin) holds that same
 * settings object. Afterwards the old value is gone, and a plugin's
 * `isLiveChange(key, newValue, oldValue)` would compare the new value with
 * itself. A key the patch adds is recorded as `undefined`, so the module
 * never falls back to its already-patched config for it. References are
 * enough: a settings write replaces the value whole (the tree refuses writes
 * below `settings/<key>`), so the old value is never mutated.
 */
export function previousSettings(
    ops: PatchOp[],
    config: Record<string, unknown>,
): Map<string, Settings> {
    const modules = (config.modules ?? {}) as Record<string, { settings?: Settings }>;
    const previous = new Map<string, Settings>();
    for (const op of ops) {
        const [root, id, branch, key] = op.path.split('/').filter(Boolean);
        const settings = modules[id]?.settings;
        if (root !== 'modules' || branch !== 'settings' || !key || !settings) continue;
        if (!previous.has(id)) previous.set(id, {});
        previous.get(id)![key] = settings[key];
    }
    return previous;
}
