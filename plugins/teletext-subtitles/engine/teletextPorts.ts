/**
 * Dynamic ports + page config helpers for the teletext subtitle decoder.
 * Pure so they unit-test with plain values; the pipeline assembly lives in
 * `teletextPipeline.ts`.
 *
 * Two page sources feed the port list: `detectedPages` (page numbers the
 * operator picked from the list the stream announces in its PMT teletext
 * descriptor — persisted as `discoveredPages` by the module) and `pages`
 * (manual entries for pages the stream does not announce).
 */

import type { DynamicPort } from '@media-router/engine';
import { isoLanguage } from '@media-router/plugin-mpegts-core';
import type { AnnouncedPage } from './teletextDescriptor.js';

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
/** Decoders per module (one `teletextdec` each); the manifest caps `pages` the same. */
export const MAX_PAGES = 8;

/** Port id keyed by PAGE NUMBER, not list index: picking another detected
 *  page must never shift the ids of pages already wired. */
export function outputPortId(page: number): string {
    return `${OUTPUT_PORT_PREFIX}${page}`;
}

function toPage(value: unknown): number | undefined {
    const n = Math.round(Number(value));
    // Magazine 9 does not exist and 8xx pages are coded as magazine 0; the
    // element rejects anything outside 100–899 at set time.
    return Number.isFinite(n) && n >= 100 && n <= 899 ? n : undefined;
}

/** The manual page list, sanitised; an entry without a valid page is skipped. */
export function readPages(config: Record<string, unknown>): TeletextPage[] {
    const arr = config.pages;
    if (!Array.isArray(arr)) return [];
    const out: TeletextPage[] = [];
    for (const raw of arr) {
        const e = (raw ?? {}) as Record<string, unknown>;
        const page = toPage(e.page);
        if (page === undefined) continue;
        out.push({
            page,
            language: isoLanguage(e.language),
            name: typeof e.name === 'string' ? e.name.trim() : '',
        });
    }
    return out;
}

/** Pages the stream announced, as the module persisted them (`discoveredPages`). */
export function readDiscoveredPages(config: Record<string, unknown>): AnnouncedPage[] {
    const arr = config.discoveredPages;
    if (!Array.isArray(arr)) return [];
    const out: AnnouncedPage[] = [];
    for (const raw of arr) {
        const e = (raw ?? {}) as Record<string, unknown>;
        const page = toPage(e.page);
        if (page === undefined) continue;
        out.push({
            page,
            language: isoLanguage(e.language),
            type: Number.isFinite(Number(e.type)) ? Number(e.type) : 0,
        });
    }
    return out;
}

/** Page numbers the operator picked from the detected list (`detectedPages`). */
export function readSelectedPages(config: Record<string, unknown>): number[] {
    const arr = config.detectedPages;
    if (!Array.isArray(arr)) return [];
    const out: number[] = [];
    for (const v of arr) {
        const page = toPage(v);
        if (page !== undefined && !out.includes(page)) out.push(page);
    }
    return out;
}

/**
 * Every page this module should decode: picked detected pages (language from
 * the announced list) followed by manual pages, one entry per page number. A
 * manual entry for an already-picked page only contributes its name. NOT
 * capped — callers take the first MAX_PAGES and may report the rest.
 */
export function resolvePages(config: Record<string, unknown>): TeletextPage[] {
    const announced = new Map(readDiscoveredPages(config).map((p) => [p.page, p]));
    const byPage = new Map<number, TeletextPage>();
    for (const page of readSelectedPages(config)) {
        byPage.set(page, { page, language: announced.get(page)?.language ?? '', name: '' });
    }
    for (const p of readPages(config)) {
        const prev = byPage.get(p.page);
        if (!prev) {
            byPage.set(p.page, p);
            continue;
        }
        if (p.name) prev.name = p.name;
        if (!prev.language) prev.language = p.language;
    }
    return [...byPage.values()];
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
    for (const p of pages) {
        ports.push({
            id: outputPortId(p.page),
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
    }
    return ports;
}
