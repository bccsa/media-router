/** The one redaction step for what is logged or shown (B-109): a launch string, element property,
 *  URI, settings object or error message keeps its shape, each secret's value becomes `<redacted>`.
 *  Only copies for a log or a reader pass here; a pipeline gets the real value. */

export const REDACTED = '<redacted>';

/** A secret is marked by its name: a setting, element property, URI parameter, environment
 *  variable or field whose name, case, `-_.` and spaces aside, ends in one of these or is in
 *  `SECRET_NAMES`. */
const SECRET_ENDINGS = [
    'secret',
    'passphrase',
    'password',
    'passwd',
    'token',
    'apikey',
    'streamkey',
    'privatekey',
    'encryptionkey',
    'signature',
    'credential',
    'credentials',
    'authorization',
];
/** souphttpsrc's `user-pw` / `proxy-pw`, and the short names of signed and keyed URLs. */
const SECRET_NAMES = new Set(['userpw', 'proxypw', 'pwd', 'psk', 'sig', 'hdnts', 'hdnea']);

export function isSecretKey(name: string): boolean {
    const n = name.toLowerCase().replace(/[-_.\s]/g, '');
    return SECRET_NAMES.has(n) || SECRET_ENDINGS.some((e) => n.endsWith(e));
}

/** A quoted value keeps its quotes; an empty one has nothing to hide. */
const hasText = (value: string): boolean => value.replace(/^["']|["']$/g, '') !== '';
const masked = (value: string): string =>
    value[0] === '"' ? `"${REDACTED}"` : value[0] === "'" ? `'${REDACTED}'` : REDACTED;

// `Authorization: <scheme> <credentials>` (any scheme), then a `Bearer <token>` anywhere else.
const AUTH_HEADER = /\b((?:proxy-)?authorization\s*:\s*)[^\r\n"',;]+/gi;
const BEARER = /\b(bearer\s+)[\w~+/.=-]+/gi;
// `scheme://user:password@host`: the password.
const USERINFO = /(?<![\w+.-])([A-Za-z][\w+.-]*:\/\/[^\s/?#@:"'<>]*):([^\s/?#"'<>]+)@/g;
// An RTMP(S) stream key: everything after the application in the path.
const RTMP_KEY = /(?<![\w+.-])(rtmp[a-z]*:\/\/[^\s/"'<>]+\/[^\s/?#"'<>]+\/)[^\s"'<>]+/gi;
// A URI parameter's name, after `?`, `&` or `;`. A secret's value runs to the next `&`, `#`, double
// quote or line end: an SRT passphrase goes in as typed, and srtsrc and srtsink keep `;`, `'` or a
// space in it.
const URI_PARAM = /[?&;]([A-Za-z][\w.-]*)=/g;
const URI_VALUE = /[^&#"\r\n]*/y;
// `name=value`: a launch-string property (quoted or bare), an environment variable, a `--flag=`.
const ASSIGNMENT =
    /(^|[\s,;({["'])(-{0,2}[A-Za-z][\w.-]*)=("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|\S*)/g;
// `"name": value` / `name: 'value'`: JSON or an object printed into text.
const PAIR =
    /(?<![\w.-])(["']?)([A-Za-z][\w.-]*)\1(\s*:\s*)("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|[^\s,;}\]]+)/g;
// A command line's `--name value`.
const FLAG = /(^|\s)(--[A-Za-z][\w.-]*)(\s+)(?!-)("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|\S+)/g;

/** Each secret URI parameter's value replaced. Only a secret's value is read, so a parameter after
 *  another one's value (a second URI on the line) is still found. */
function redactUriParams(text: string): string {
    let out = '';
    let done = 0;
    for (const m of text.matchAll(URI_PARAM)) {
        const start = m.index + m[0].length;
        if (m.index < done || !isSecretKey(m[1])) continue;
        URI_VALUE.lastIndex = start;
        const end = start + (URI_VALUE.exec(text)?.[0].length ?? 0);
        if (end === start) continue;
        out += text.slice(done, start) + REDACTED;
        done = end;
    }
    return out + text.slice(done);
}

/** `text` with the value of every secret it names replaced, in each of the forms above. */
export function redactSecrets(text: string): string {
    const head = text
        .replace(AUTH_HEADER, `$1${REDACTED}`)
        .replace(BEARER, `$1${REDACTED}`)
        .replace(USERINFO, `$1:${REDACTED}@`)
        .replace(RTMP_KEY, `$1${REDACTED}`);
    return redactUriParams(head)
        .replace(ASSIGNMENT, (m, pre: string, name: string, value: string) =>
            hasText(value) && isSecretKey(name) ? `${pre}${name}=${masked(value)}` : m,
        )
        .replace(PAIR, (m, q: string, name: string, sep: string, value: string) =>
            hasText(value) && isSecretKey(name) ? `${q}${name}${q}${sep}${masked(value)}` : m,
        )
        .replace(FLAG, (m, pre: string, flag: string, ws: string, value: string) =>
            isSecretKey(flag) ? `${pre}${flag}${ws}${masked(value)}` : m,
        );
}

const isSecretFlag = (v: unknown): boolean =>
    typeof v === 'string' && /^--?[A-Za-z][\w.-]*$/.test(v) && isSecretKey(v);
const hasValue = (v: unknown): boolean =>
    v !== undefined && v !== null && v !== '' && typeof v !== 'boolean';

/** `value` (JSON data: a log line, settings, ops, a command line) with every secret redacted: a
 *  secret field, an op's or property set's `value` on a secret name, the argument after a secret
 *  flag, every string by `redactSecrets`. What did not change keeps its identity. */
export function redactValue<T>(value: T): T {
    if (typeof value === 'string') return redactSecrets(value) as T;
    if (Array.isArray(value)) {
        const out = value.map((item: unknown, i) =>
            isSecretFlag(value[i - 1]) && hasValue(item) ? REDACTED : redactValue(item),
        );
        return (out.some((item, i) => item !== value[i]) ? out : value) as T;
    }
    if (value === null || typeof value !== 'object') return value;
    const obj = value as Record<string, unknown>;
    // An op's `path` or a property set's `property`; no log site prints a `{ key, value }` pair.
    const target = typeof obj.path === 'string' ? obj.path.split('/').pop() : obj.property;
    const valueIsSecret = typeof target === 'string' && isSecretKey(target);
    const entries = Object.entries(obj).map(([key, v]) => {
        const secret = isSecretKey(key) || (key === 'value' && valueIsSecret);
        return [key, secret && hasValue(v) ? REDACTED : redactValue(v)] as const;
    });
    return (entries.some(([key, v]) => v !== obj[key]) ? Object.fromEntries(entries) : value) as T;
}
