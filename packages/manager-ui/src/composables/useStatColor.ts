/** Return a Tailwind color class based on value thresholds (normal → warning → error). */
export function statColorClass(value: number, warn: number, crit: number): string {
    if (value >= crit) return 'text-error';
    if (value >= warn) return 'text-warning';
    return 'text-muted';
}
