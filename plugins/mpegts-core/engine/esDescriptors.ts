/**
 * PMT ES descriptor-loop reader (ISO 13818-1 §2.6). The runner hands a plugin
 * each ES's raw descriptor loop as hex (`esInfo` on `tssplit:discovered` and
 * `tsprobe:pmt`); descriptor data is source-controlled wire input, so every
 * walk is bounded and total — garbage yields an empty list, never a throw.
 */

export interface EsDescriptor {
    tag: number;
    /** Descriptor payload (without tag + length). */
    data: Buffer;
}

/** Raw loop bytes from the hex field — undefined when absent or not clean hex. */
export function esInfoBytes(esInfoHex: string | undefined): Buffer | undefined {
    if (!esInfoHex || !/^[0-9a-fA-F]+$/.test(esInfoHex) || esInfoHex.length % 2 !== 0) {
        return undefined;
    }
    return Buffer.from(esInfoHex, 'hex');
}

/** Every complete descriptor in the loop, in order; a truncated tail is dropped. */
export function descriptorsFromEsInfo(esInfoHex: string | undefined): EsDescriptor[] {
    const bytes = esInfoBytes(esInfoHex);
    if (!bytes) return [];
    const out: EsDescriptor[] = [];
    for (let i = 0; i + 2 <= bytes.length; i += 2 + bytes[i + 1]) {
        const len = bytes[i + 1];
        if (i + 2 + len > bytes.length) break;
        out.push({ tag: bytes[i], data: bytes.subarray(i + 2, i + 2 + len) });
    }
    return out;
}

/** An ISO 639-2 code as the fleet stores it: three letters, lowercase; else ''. */
export function isoLanguage(value: unknown): string {
    const s = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return /^[a-z]{3}$/.test(s) ? s : '';
}
