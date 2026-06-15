/**
 * Pure stream-inspector state for the MPEG-TS demuxer.
 *
 * Collects the `stream_discovered` events the runner emits per tsdemux pad
 * (Phase 1) into a PID-keyed table and renders it for the module's status
 * panel. Kept free of GStreamer / engine imports so it's unit-testable with
 * plain event objects.
 *
 * Per plan D6 this is report-only — nothing here may influence routing or
 * health. PID is the stable key (plan D3); a re-discovered PID updates in
 * place rather than duplicating, which is what a pipeline restart produces.
 */

export type StreamMedia = 'video' | 'audio' | 'metadata' | 'subtitle' | 'data';

export interface DiscoveredStream {
    /** Stream PID, or null if the pad name didn't parse (degraded, still listed). */
    pid: number | null;
    media: StreamMedia;
    /** Raw caps string from the pad (e.g. `audio/mpeg, mpegversion=(int)4, …`). */
    caps: string;
    /** Short codec label derived from caps (e.g. `aac`, `h264`). */
    codec: string;
    /** ISO-639 language tag from the pad's PMT descriptor, if tsdemux set one
     *  on the caps (e.g. `language=(string)eng`). Second in the label-resolution
     *  order, below the KLV name and above the generated label. */
    language: string | null;
}

export interface StreamDiscoveredEvent {
    pid?: number | null;
    media?: string;
    caps?: string;
    padName?: string;
}

/** Caps structure name → short codec label for the inspector panel. */
const CODEC_LABELS: Record<string, string> = {
    'video/x-h264': 'h264',
    'video/x-h265': 'h265',
    'video/x-av1': 'av1',
    'audio/x-ac3': 'ac3',
    'audio/x-eac3': 'eac3',
    'audio/x-opus': 'opus',
    'meta/x-klv': 'klv',
    'subpicture/x-dvb': 'dvbsub',
    'application/x-teletext': 'teletext',
};

/**
 * Pull an ISO-639 language tag from a caps string, if tsdemux set one from a
 * PMT ISO-639 language descriptor (`language=(string)eng`). Returns null when
 * absent. Second tier of the label-resolution order (KLV name → language →
 * generated).
 */
export function languageFromCaps(caps: string): string | null {
    const m = /language=\(string\)([a-z]{2,3})\b/i.exec(caps);
    return m ? m[1].toLowerCase() : null;
}

/**
 * Derive a short codec label from a caps string. `audio/mpeg` is split into
 * `aac` (mpegversion 2/4) vs `mp2` (mpegversion 1) — same disambiguation the
 * runner's parser table makes. Falls back to the bare caps structure name so
 * an unknown codec still shows something meaningful.
 */
export function codecFromCaps(caps: string): string {
    const name = (caps.split(',')[0] || '').trim();
    if (name === 'audio/mpeg') {
        if (/mpegversion=\(int\)1\b/.test(caps)) return 'mp2';
        if (/mpegversion=\(int\)(2|4)\b/.test(caps)) return 'aac';
        return 'mpeg-audio';
    }
    return CODEC_LABELS[name] || name || 'unknown';
}

function normaliseMedia(media: string | undefined): StreamMedia {
    if (
        media === 'video' ||
        media === 'audio' ||
        media === 'metadata' ||
        media === 'subtitle'
    ) {
        return media;
    }
    return 'data';
}

/**
 * Collects discovered streams keyed by PID. A new pipeline run (restart)
 * re-emits the same PIDs; `record` upserts so the table reflects the latest
 * TS without growing unbounded. Streams with an unparseable PID (null) are
 * keyed by pad name so they're still listed without colliding.
 */
export class StreamInspector {
    private readonly streams = new Map<string, DiscoveredStream>();

    /** Upsert one discovered stream. Returns the parsed entry. */
    record(event: StreamDiscoveredEvent): DiscoveredStream {
        const caps = event.caps ?? '';
        const entry: DiscoveredStream = {
            pid: typeof event.pid === 'number' ? event.pid : null,
            media: normaliseMedia(event.media),
            caps,
            codec: codecFromCaps(caps),
            language: languageFromCaps(caps),
        };
        const key = entry.pid !== null ? `pid:${entry.pid}` : `pad:${event.padName ?? caps}`;
        this.streams.set(key, entry);
        return entry;
    }

    /** Clear all collected streams (called on stop/restart of the module). */
    clear(): void {
        this.streams.clear();
    }

    /** Discovered streams, sorted by PID (nulls last) for a stable panel. */
    list(): DiscoveredStream[] {
        return [...this.streams.values()].sort((a, b) => {
            if (a.pid === null) return b.pid === null ? 0 : 1;
            if (b.pid === null) return -1;
            return a.pid - b.pid;
        });
    }

    /** Count of discovered streams. */
    get size(): number {
        return this.streams.size;
    }

    /** Format the PID as `0x141` for display, or `—` when unknown. */
    static formatPid(pid: number | null): string {
        return pid === null ? '—' : `0x${pid.toString(16)}`;
    }

    /**
     * Resolve a stream's display label per the plan's order:
     *   KLV name → ISO-639 language descriptor → generated label.
     * `klvNames` is the demuxer's PID-keyed in-band name store; a null PID can
     * never match a KLV name, so those streams fall straight through to the
     * generated label. The generated form mirrors the plan's example
     * (`Audio (aac, PID 0x141)`).
     */
    static resolveLabel(stream: DiscoveredStream, klvNames: Map<number, string>): string {
        if (stream.pid !== null) {
            const name = klvNames.get(stream.pid);
            if (name) return name;
        }
        if (stream.language) return `${stream.media} (${stream.language})`;
        const media = stream.media.charAt(0).toUpperCase() + stream.media.slice(1);
        return `${media} (${stream.codec}, PID ${StreamInspector.formatPid(stream.pid)})`;
    }
}
