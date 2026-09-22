/**
 * Teletext pages a service ANNOUNCES: the DVB teletext descriptor (EN 300 468
 * tag 0x56) in an ES's PMT descriptor loop lists, per page, the ISO 639
 * language, the teletext type (2 = subtitles, 5 = hearing-impaired
 * subtitles) and the magazine + page number. Pure so it unit-tests on hex
 * strings; the module feeds it the `tsprobe:pmt` event.
 */

import { descriptorsFromEsInfo, isoLanguage } from '@media-router/plugin-mpegts-core';

export interface AnnouncedPage {
    /** Decimal page 100–899 (magazine 0 on the wire = 8xx). */
    page: number;
    /** ISO 639-2 code, lowercase, or '' when the descriptor carries junk. */
    language: string;
    /** teletext_type: 1 initial, 2 subtitles, 3 info, 4 schedule, 5 HI subtitles. */
    type: number;
}

const TYPE_LABEL: Record<number, string> = {
    1: 'initial page',
    2: 'subtitles',
    3: 'info',
    4: 'schedule',
    5: 'HI subtitles',
};

export function teletextTypeLabel(type: number): string {
    return TYPE_LABEL[type] ?? `type ${type}`;
}

/** Pages announced by ONE ES's descriptor loop (hex); malformed entries are skipped. */
export function teletextPagesFromEsInfo(esInfoHex: string | undefined): AnnouncedPage[] {
    const out: AnnouncedPage[] = [];
    for (const { tag, data } of descriptorsFromEsInfo(esInfoHex)) {
        // 0x46 (VBI teletext) shares the 0x56 layout
        if (tag !== 0x56 && tag !== 0x46) continue;
        for (let j = 0; j + 5 <= data.length; j += 5) {
            const type = data[j + 3] >> 3;
            const magazine = data[j + 3] & 0x07;
            const tens = data[j + 4] >> 4;
            const units = data[j + 4] & 0x0f;
            if (tens > 9 || units > 9) continue;
            const page = (magazine === 0 ? 8 : magazine) * 100 + tens * 10 + units;
            out.push({
                page,
                language: isoLanguage(data.subarray(j, j + 3).toString('latin1')),
                type,
            });
        }
    }
    return out;
}

/** Pages announced anywhere in a PMT (all ESs), one entry per page number,
 *  sorted. Subtitle types win when a page is listed twice. */
export function announcedPages(
    streams: Array<{ streamType?: number; esInfo?: string }> | undefined,
): AnnouncedPage[] {
    const byPage = new Map<number, AnnouncedPage>();
    for (const s of streams ?? []) {
        for (const p of teletextPagesFromEsInfo(s.esInfo)) {
            const prev = byPage.get(p.page);
            const isSub = p.type === 2 || p.type === 5;
            if (!prev || (isSub && prev.type !== 2 && prev.type !== 5)) byPage.set(p.page, p);
        }
    }
    return [...byPage.values()].sort((a, b) => a.page - b.page);
}

export function sameAnnounced(a: AnnouncedPage[], b: AnnouncedPage[]): boolean {
    if (a.length !== b.length) return false;
    return a.every(
        (p, i) => p.page === b[i].page && p.language === b[i].language && p.type === b[i].type,
    );
}

/** `888 eng · subtitles` — the one label shape for pick list and status. */
export function announcedLabel(p: AnnouncedPage): string {
    return `${p.page}${p.language ? ` ${p.language}` : ''} · ${teletextTypeLabel(p.type)}`;
}

/** Option list for the `detectedPages` multi-select (`x-optionsFrom`). */
export function pageOptions(pages: AnnouncedPage[]): Array<{ value: string; label: string }> {
    return pages.map((p) => ({ value: String(p.page), label: announcedLabel(p) }));
}
