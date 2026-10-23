/**
 * What a typed settings box accepts (B-104): its field's rules, read when the entry commits (Enter,
 * leaving the box, a spinner step), never while typing.
 */
export interface EntryRule {
    /** The field's JSON Schema type: 'number' and 'integer' read a number, any other keeps the text. */
    type?: string;
    min?: number;
    /** The effective maximum: `maximum` after x-maxFrom or x-maxBy. */
    max?: number;
    /** Follows a bound in the reason ("Must be between -10000 and 10000 ms"). */
    unit?: string;
    /** A number rounds to whole steps before its bounds are checked (the PID trims). */
    step?: number;
    pattern?: string;
    minLength?: number;
    maxLength?: number;
    enum?: readonly unknown[];
    /** An empty box commits '' (an override that then inherits) instead of being refused. */
    optional?: boolean;
    /** A rule the schema cannot state (a unique value, an address form): why it is refused, or nothing. */
    check?: (value: string | number) => string | undefined;
}

/** A committed entry: the value to write, or why it is refused. */
export type Entry = { value: string | number } | { reason: string };

export const isNumberType = (type: string | undefined): boolean =>
    type === 'number' || type === 'integer';

/** Reads a box's text against its rule; `badInput` is a number box holding text it cannot parse. */
export function readEntry(text: string, rule: EntryRule, badInput = false): Entry {
    if (!isNumberType(rule.type)) return entry(text, textReason(text, rule) ?? rule.check?.(text));
    if (!badInput && text.trim() === '') {
        return rule.optional ? { value: '' } : { reason: 'Enter a number' };
    }
    let n = badInput ? NaN : Number(text);
    if (!Number.isFinite(n)) return { reason: 'Enter a number' };
    if (rule.step) n = Math.round(n / rule.step) * rule.step;
    if (rule.type === 'integer' && !Number.isInteger(n)) return { reason: 'Enter a whole number' };
    return entry(n, rangeReason(n, rule) ?? enumReason(n, rule.enum) ?? rule.check?.(n));
}

/** Whether an entry is the value already stored: an empty box and an unset value are one. */
export function sameValue(value: unknown, stored: unknown): boolean {
    const blank = (v: unknown) => v === '' || v === undefined || v === null;
    return value === stored || (blank(value) && blank(stored));
}

function entry(value: string | number, reason: string | undefined): Entry {
    return reason === undefined ? { value } : { reason };
}

function rangeReason(n: number, { min, max, unit }: EntryRule): string | undefined {
    const low = min !== undefined && n < min;
    if (!low && !(max !== undefined && n > max)) return undefined;
    const u = unit ? ` ${unit}` : '';
    if (min !== undefined && max !== undefined) return `Must be between ${min} and ${max}${u}`;
    return low ? `Must be at least ${min}${u}` : `Must be at most ${max}${u}`;
}

function textReason(text: string, rule: EntryRule): string | undefined {
    const length = [...text].length;
    if (rule.minLength !== undefined && length < rule.minLength) {
        return `Must be at least ${rule.minLength} characters`;
    }
    if (rule.maxLength !== undefined && length > rule.maxLength) {
        return `Must be at most ${rule.maxLength} characters`;
    }
    if (rule.pattern !== undefined && !new RegExp(rule.pattern).test(text)) {
        return 'Not in the required format';
    }
    return enumReason(text, rule.enum);
}

function enumReason(
    value: string | number,
    allowed: readonly unknown[] | undefined,
): string | undefined {
    if (!allowed || allowed.some((a) => String(a) === String(value))) return undefined;
    return `Must be one of: ${allowed.join(', ')}`;
}
