// B-197: an output that plays nothing never shows ok. After SILENT_OUTPUT_MS a warning that
// stays until it plays again: its mixer delivers no audio (relaunched once), or every buffer
// reaches the sink past its playout time (the ring skips it; the route's re-anchor raises D).

/** How long an output may play nothing before it says so (c18's capture stall is 4 s). */
export const SILENT_OUTPUT_MS = 5_000;
/** No meter reading for this long is no audio: the runner re-sends one at least every second. */
export const NO_READING_MS = 1_500;
/** Past its playout time by more than this, a buffer is skipped whole (REANCHOR_TOLERANCE_MS). */
export const LATE_SLACK_MS = 40;
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
     *  One source plays direct: no audio is that source's silence (FF9 has its resume). */
    mixes(): boolean;
    /** The lateness window at the sink's input (ms); undefined while that tap reads nothing. */
    sinkLateness(): { minMs: number } | undefined;
    /** The latest a buffer may reach the sink and still play: ts-offset + its latency (ms). */
    playoutBudgetMs(): number;
    /** The module's warning (null: withdrawn). */
    warn(text: string | null): void;
    log(): {
        info(obj: object, msg: string): void;
        warn(obj: object, msg: string): void;
    };
}

/** Why nothing plays: a stalled mix is relaunched; a late one is not (a relaunch replays the
 *  same pace and restarts the re-anchor's hold). */
interface Silence {
    reason: string;
    stalled: boolean;
}

export class SilentOutputWatch {
    private timer: ReturnType<typeof setInterval> | null = null;
    private playingAt = 0;
    private lastVuAt: number | undefined;
    /** Since when nothing plays, this launch; undefined while it plays. */
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

    /** Why nothing plays now; 'plays' once it is heard of; null while it cannot tell yet. */
    private silence(at: number): Silence | 'plays' | null {
        if (this.host.mixes() && at - (this.lastVuAt ?? this.playingAt) >= NO_READING_MS) {
            return { reason: 'its mixer delivers no audio', stalled: true };
        }
        const late = this.host.sinkLateness();
        const pastMs = late ? late.minMs - this.host.playoutBudgetMs() : 0;
        if (pastMs > LATE_SLACK_MS) {
            const reason = `every buffer reaches the sink ${Math.round(pastMs)} ms past its playout time`;
            return { reason, stalled: false };
        }
        return this.lastVuAt !== undefined ? 'plays' : null;
    }

    private tick(): void {
        const at = this.now();
        const silence = this.host.playing() ? this.silence(at) : null;
        if (silence === null || silence === 'plays') {
            this.silentSince = undefined;
            if (this.episode && silence === 'plays') {
                this.host.log().info({}, 'Plays again');
                this.host.warn(null);
                this.episode = null;
            }
            return;
        }
        this.silentSince ??= at;
        if (at - this.silentSince < SILENT_OUTPUT_MS) return;
        const relaunched = this.episode?.relaunched ?? false;
        const relaunch =
            silence.stalled && !relaunched && at - this.lastRelaunchAt >= SILENT_RELAUNCH_GAP_MS;
        const text = `Plays nothing: ${silence.reason}${relaunch || relaunched ? ' — relaunched' : ''}`;
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
