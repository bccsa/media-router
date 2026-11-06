// B-197: an output that plays nothing never shows ok. Its mixer delivers no audio: said after
// SILENT_OUTPUT_MS and relaunched once, until it plays. A sink that plays on arrival (B-167) is
// never late at a playout time, and a stopped device is mrasrc's `device-stalled` (B-166).

/** How long a mix may deliver no audio before it says so (c18's capture stall is 4 s). */
export const SILENT_OUTPUT_MS = 5_000;
/** No meter reading for this long is no audio: the runner re-sends one at least every second. */
export const NO_READING_MS = 1_500;
/** At most one relaunch per this long, whatever the episodes. */
export const SILENT_RELAUNCH_GAP_MS = 60_000;
const TICK_MS = 1_000;

/** The slice of `GstChildProcess` this needs. */
export interface SilentOutputPipeline {
    restartPipeline(reason: string): Promise<void>;
}

export interface SilentOutputHost {
    pipeline(): SilentOutputPipeline | null;
    /** The pipeline is PLAYING: only then is silence its own (a gate, a PipeWire loss are not). */
    playing(): boolean;
    /** It runs the mixer: its aligners gap a dark input, so no audio at all is its own stall.
     *  One source plays direct: no audio is that source's silence, shown on that source. */
    mixes(): boolean;
    /** The module's warning (null: withdrawn). */
    warn(text: string | null): void;
    log(): {
        info(obj: object, msg: string): void;
        warn(obj: object, msg: string): void;
    };
}

const STALLED = 'Plays nothing: its mixer delivers no audio';

export class SilentOutputWatch {
    private timer: ReturnType<typeof setInterval> | null = null;
    private playingAt = 0;
    private lastVuAt: number | undefined;
    /** Since when the mix delivers no audio, this launch; undefined while it does. */
    private silentSince: number | undefined;
    /** The open episode's warning text: it outlives the relaunch, until the output plays. */
    private episode: { text: string; relaunched: boolean } | null = null;
    private lastRelaunchAt = -Infinity;

    constructor(
        private readonly host: SilentOutputHost,
        private readonly now: () => number = () => Date.now(),
    ) {}

    /** Every PLAYING: a fresh launch gets its own SILENT_OUTPUT_MS; an open episode's text stays. */
    onPlaying(): void {
        this.playingAt = this.now();
        this.lastVuAt = undefined;
        this.silentSince = undefined;
        if (this.episode) this.host.warn(this.episode.text);
        if (!this.timer) {
            this.timer = setInterval(() => this.tick(), TICK_MS);
            this.timer.unref?.();
        }
    }

    /** A meter reading: the mix delivered audio. */
    onVu(): void {
        this.lastVuAt = this.now();
    }

    /** Stop, destroy, device gone: nothing runs, nothing to say. */
    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.silentSince = undefined;
        if (this.episode) this.host.warn(null);
        this.episode = null;
    }

    /** The mix stalled, it plays, or (null) it cannot tell yet. */
    private judge(at: number): 'stalled' | 'plays' | null {
        if (this.host.mixes() && at - (this.lastVuAt ?? this.playingAt) >= NO_READING_MS) {
            return 'stalled';
        }
        return this.lastVuAt !== undefined ? 'plays' : null;
    }

    private tick(): void {
        const at = this.now();
        const verdict = this.host.playing() ? this.judge(at) : null;
        if (verdict !== 'stalled') {
            this.silentSince = undefined;
            if (this.episode && verdict === 'plays') {
                this.host.log().info({}, 'Plays again');
                this.host.warn(null);
                this.episode = null;
            }
            return;
        }
        this.silentSince ??= at;
        if (at - this.silentSince < SILENT_OUTPUT_MS) return;
        const relaunched = this.episode?.relaunched ?? false;
        const relaunch = !relaunched && at - this.lastRelaunchAt >= SILENT_RELAUNCH_GAP_MS;
        const text = `${STALLED}${relaunch || relaunched ? ' — relaunched' : ''}`;
        if (this.episode?.text !== text) this.host.log().warn({ relaunch }, text);
        this.episode = { text, relaunched: relaunched || relaunch };
        this.host.warn(text);
        if (!relaunch) return;
        this.lastRelaunchAt = at;
        this.silentSince = undefined;
        void this.host
            .pipeline()
            ?.restartPipeline('plays nothing')
            .catch((err) => this.host.log().warn({ err }, 'Relaunch after playing nothing failed'));
    }
}
