// B-197: an output that plays nothing never shows ok. Its mixer delivers no audio (said after
// SILENT_OUTPUT_MS, relaunched once), or every buffer reaches the sink past its playout time (the
// ring skips it; said as soon as the runner's playout watch reports it, B-206) — until it plays.

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
     *  One source plays direct: no audio is that source's silence (FF9 has its resume). */
    mixes(): boolean;
    /** Its route's raise is held (B-210): a raise did not change its lateness, so its sink plays
     *  at its own pace and the runner's miss is that pace, not silence. */
    held?(): boolean;
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
    /** The runner's last playout verdict; a relaunch keeps it until its own (a late sink is not
     *  said to play again before the runner sees it in budget). Null until it said. */
    private playout: { playing: boolean; lateMs: number } | null = null;
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

    /** The runner's playout watch (`playout_watch`): the sink missed its playout for a second, or
     *  plays on time again. Said at once (B-206: within 3 s, never ok between). */
    onPlayout(playing: boolean, lateMs: number): void {
        this.playout = { playing, lateMs };
        this.tick();
    }

    /** Judge again now (the route's raise became held, or no longer is). */
    refresh(): void {
        this.tick();
    }

    /** Stop, destroy, device gone: nothing runs, nothing to say. */
    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.silentSince = undefined;
        this.playout = null;
        if (this.episode) this.host.warn(null);
        this.episode = null;
    }

    /** Why nothing plays now; 'plays' once it is heard of; null while it cannot tell yet. */
    private silence(at: number): Silence | 'plays' | null {
        if (this.host.mixes() && at - (this.lastVuAt ?? this.playingAt) >= NO_READING_MS) {
            return { reason: 'its mixer delivers no audio', stalled: true };
        }
        if (this.playout?.playing === false && !this.host.held?.()) {
            const late = Math.round(this.playout.lateMs);
            return {
                reason: `every buffer reaches the sink ${late} ms past its playout time`,
                stalled: false,
            };
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
        // A stalled mix gets SILENT_OUTPUT_MS; a late sink is said at once (the runner held it).
        this.silentSince ??= at;
        if (silence.stalled && at - this.silentSince < SILENT_OUTPUT_MS) return;
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
