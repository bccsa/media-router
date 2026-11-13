/**
 * Read an optional number from untrusted config: blank (`undefined`, `null`,
 * `''`) or non-numeric is `undefined`, so the caller can inherit or default;
 * anything else is clamped to [min, max], rounded first when `integer`.
 * Accepts numeric strings (hand-edited profiles).
 */
export function readClampedNumber(
    value: unknown,
    min: number,
    max: number,
    integer = false,
): number | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    const n = integer ? Math.round(Number(value)) : Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : undefined;
}
