/**
 * Dynamic ports + page config helpers for the teletext subtitle decoder.
 * Pure (type-only engine imports) so they unit-test with plain values; the
 * pipeline assembly lives in `teletextPipeline.ts`.
 */

import type { DynamicPort } from '@media-router/engine';

export type { DynamicPort };

export interface TeletextPage {
    /** Decimal page number 100–899 (teletextdec's `page` property is decimal). */
    page: number;
    /** ISO 639-2 code or '' when unknown. */
    language: string;
    /** Operator label or ''. */
    name: string;
}

export const INPUT_PORT_ID = 'mpegts-in';
const OUTPUT_PORT_PREFIX = 'page-';
export const MAX_PAGES = 8;

/** Provisional page when config carries none — the engine resolves ports once
 *  BEFORE the module starts (empty config), and a node with no output port on
 *  add is a dead end. Kept in sync with the manifest `pages` default. */
const DEFAULT_PAGE: TeletextPage = { page: 888, language: 'eng', name: '' };

export function outputPortId(index: number): string {
    return `${OUTPUT_PORT_PREFIX}${index}`;
}

function toPage(value: unknown): number | undefined {
    const n = Math.round(Number(value));
    // Magazine 9 does not exist and 8xx pages are coded as magazine 0; the
    // element rejects anything outside 100–899 at set time.
    return Number.isFinite(n) && n >= 100 && n <= 899 ? n : undefined;
}

/** Read + sanitise the page list; a malformed entry falls back to page 888. */
export function readPages(config: Record<string, unknown>): TeletextPage[] {
    const arr = config.pages;
    if (!Array.isArray(arr)) return [{ ...DEFAULT_PAGE }];
    return arr.slice(0, MAX_PAGES).map((raw) => {
        const e = (raw ?? {}) as Record<string, unknown>;
        const lang = typeof e.language === 'string' ? e.language.trim().toLowerCase() : '';
        return {
            page: toPage(e.page) ?? DEFAULT_PAGE.page,
            language: /^[a-z]{3}$/.test(lang) ? lang : '',
            name: typeof e.name === 'string' ? e.name.trim() : '',
        };
    });
}

/** Port label: operator name, else `eng 888`, else `Page 888`. */
export function pageLabel(p: TeletextPage): string {
    if (p.name) return p.name;
    return p.language ? `${p.language} ${p.page}` : `Page ${p.page}`;
}

/** One MPEG-TS input + one subtitle output per page. */
export function buildDynamicPorts(pages: TeletextPage[]): DynamicPort[] {
    const ports: DynamicPort[] = [
        {
            id: INPUT_PORT_ID,
            direction: 'input',
            streamType: 'muxed/mpegts',
            label: 'MPEG-TS In',
            maxConnections: 1,
            acceptsStreamTypes: ['muxed/mpegts'],
        },
    ];
    pages.forEach((p, i) => {
        ports.push({
            id: outputPortId(i),
            direction: 'output',
            streamType: 'muxed/mpegts',
            label: pageLabel(p),
            maxConnections: -1,
            requiresOrderedApply: true,
            streamInfo: {
                media: 'subtitle',
                codec: 'webvtt',
                name: pageLabel(p),
                ...(p.language ? { language: p.language } : {}),
            },
        });
    });
    return ports;
}
