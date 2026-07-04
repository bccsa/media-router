/**
 * Evaluate an `x-showWhen` condition. Format: `"key=value"`, or `"key=v1,v2"` to
 * match any of several values. The caller supplies `resolve` to source the
 * controlling field's current value — global config, item-with-global-fallback,
 * a module's live settings, etc. — so the same matching lives in one place.
 */
export function matchShowWhen(
    condition: string | undefined,
    resolve: (key: string) => unknown,
): boolean {
    if (!condition) return true;
    const [key, value] = condition.split('=');
    const allowed = (value ?? '').split(',');
    return allowed.includes(String(resolve(key) ?? ''));
}
