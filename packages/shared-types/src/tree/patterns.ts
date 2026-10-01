import { splitPath } from './paths.js';

/** A pattern segment that matches any one segment. */
export const WILDCARD = '+';

/**
 * Parse a subscription pattern. A pattern matches its node and everything
 * below it, so a trailing MQTT-style '#' adds nothing and is dropped.
 */
export function parsePattern(pattern: string): string[] {
    const segments = splitPath(pattern);
    while (segments.length > 0 && segments[segments.length - 1] === '#') segments.pop();
    return segments;
}

function segmentMatches(patternSegment: string, segment: string): boolean {
    return patternSegment === WILDCARD || patternSegment === segment;
}

/** The path lies at or below a node the pattern matches. */
export function covers(pattern: readonly string[], path: readonly string[]): boolean {
    if (pattern.length > path.length) return false;
    for (let i = 0; i < pattern.length; i++) if (!segmentMatches(pattern[i], path[i])) return false;
    return true;
}

/** The path is a strict ancestor of nodes the pattern can match. */
export function isAncestorOf(path: readonly string[], pattern: readonly string[]): boolean {
    if (path.length >= pattern.length) return false;
    for (let i = 0; i < path.length; i++) if (!segmentMatches(pattern[i], path[i])) return false;
    return true;
}

/** A write at `path` changes something the pattern delivers. */
export function overlaps(pattern: readonly string[], path: readonly string[]): boolean {
    return covers(pattern, path) || isAncestorOf(path, pattern);
}
