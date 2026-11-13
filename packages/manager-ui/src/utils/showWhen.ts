/**
 * Evaluate an `x-showWhen` condition. Format: `"key=value"`, or `"key=v1,v2"` to
 * match any of several values; clauses joined by `&` must all match
 * (`"rateControl=qvbr&encoderImpl=software,va,auto"`). The caller supplies `resolve` to source the
 * controlling field's current value — global config, item-with-global-fallback,
 * a module's live settings, etc. — so the same matching lives in one place.
 */
export function matchShowWhen(
    condition: string | undefined,
    resolve: (key: string) => unknown,
): boolean {
    if (!condition) return true;
    return condition.split('&').every((clause) => {
        const [key, value] = clause.split('=');
        const allowed = (value ?? '').split(',');
        return allowed.includes(String(resolve(key) ?? ''));
    });
}
