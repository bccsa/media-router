// Tree paths are JSON Pointers (RFC 6901): '/'-separated segments with
// '~' escaped as '~0' and '/' as '~1'. The root is '' or '/'.

export function escapeSegment(segment: string): string {
    return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

export function unescapeSegment(segment: string): string {
    return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** Split an absolute tree path into unescaped segments. */
export function splitPath(path: string): string[] {
    if (path === '' || path === '/') return [];
    const body = path.startsWith('/') ? path.slice(1) : path;
    return body.split('/').map(unescapeSegment);
}

/** Join unescaped segments into an absolute tree path. */
export function joinPath(segments: readonly string[]): string {
    return segments.length === 0 ? '/' : '/' + segments.map(escapeSegment).join('/');
}

/** True when `prefix` is `path` itself or one of its ancestors. */
export function isPrefix(prefix: readonly string[], path: readonly string[]): boolean {
    if (prefix.length > path.length) return false;
    for (let i = 0; i < prefix.length; i++) if (prefix[i] !== path[i]) return false;
    return true;
}
