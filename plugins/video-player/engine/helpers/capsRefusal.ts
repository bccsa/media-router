/**
 * The operator-facing side of a hardware decoder refusing the stream's caps
 * (`caps-refused` in decoderRuntime.ts, #867).
 *
 * The runner keeps replaying the same pipeline, so the picture comes back by
 * itself once the source is fixed. Each replay reaches PLAYING about a second
 * before the refusal, and the PLAYING edge marks the module healthy — without
 * a latch the descriptive error would flash between "ok" and the base class's
 * generic "Internal data stream error." every few seconds. The latch holds the
 * note across replays and lets it go only after a PLAYING run that lasted
 * `CAPS_REFUSED_CLEAR_MS` without another refusal.
 */

/** A clean PLAYING run this long means the decoder accepts the stream again. */
export const CAPS_REFUSED_CLEAR_MS = 10_000;

/** Health/log text for a hardware decoder that refused the stream's caps. */
export function decoderCapsRefusedNote(decoderId: string): string {
    return (
        `Hardware decoder ${decoderId} refused the stream format (not-negotiated) — no picture. ` +
        'Usual cause: an incomplete colour description (VUI) from the source encoder, e.g. ' +
        'transfer/primaries unspecified; set a full one such as BT.709 at the encoder.'
    );
}

export class CapsRefusalLatch {
    private note: string | undefined;
    private timer: NodeJS.Timeout | null = null;

    /** The note while latched, else undefined. */
    get active(): string | undefined {
        return this.note;
    }

    /**
     * Record a refusal. True on the first one (or a different note) — log it
     * loudly; false on a replay's repeat — log it quietly.
     */
    refused(note: string): boolean {
        this.cancel();
        const first = this.note !== note;
        this.note = note;
        return first;
    }

    /**
     * A PLAYING edge. Returns the note to re-assert while latched, and arms the
     * clear: `onClear` runs if no refusal arrives within `CAPS_REFUSED_CLEAR_MS`.
     */
    playing(onClear: () => void): string | undefined {
        if (!this.note) return undefined;
        this.cancel();
        this.timer = setTimeout(() => {
            this.timer = null;
            this.note = undefined;
            onClear();
        }, CAPS_REFUSED_CLEAR_MS);
        return this.note;
    }

    /** Module stop: drop the latch and its timer. */
    reset(): void {
        this.cancel();
        this.note = undefined;
    }

    private cancel(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }
}
