/** Is a playing pipeline's runner still answering (B-246)? Asked every 5 s; no answer in 3 s is a
 *  miss and the next ask goes at once. Two misses in a row warn (6 s after the first unanswered ask,
 *  6-11 s after a freeze); the next answer withdraws it. */

export const LIVENESS_PERIOD_MS = 5000;
export const LIVENESS_TIMEOUT_MS = 3000;
export const LIVENESS_MISSES = 2;

/** The module's warning while its runner does not answer, `seconds` since its last answer. */
export function notAnsweringText(seconds: number): string {
    return `Pipeline not answering for ${seconds} s (stalled or frozen)`;
}

export interface RunnerLivenessDeps {
    /** True answered, false no answer within `timeoutMs`, null not asked (down, or relaunching). */
    ask: (timeoutMs: number) => Promise<boolean | null>;
    /** Two or more misses in a row; called again on each further miss with the new text. */
    stalled: (text: string, seconds: number) => void;
    /** It answers again (or is no longer asked) after `stalled`. */
    answered: (seconds: number) => void;
    now?: () => number;
}

export class RunnerLiveness {
    private timer: ReturnType<typeof setTimeout> | null = null;
    /** Bumped by start and stop: an ask still out from before answers nobody. */
    private epoch = 0;
    private misses = 0;
    private lastAnswerAt = 0;
    private shown = false;

    constructor(private readonly deps: RunnerLivenessDeps) {}

    /** The pipeline reached PLAYING: the first ask in one period. */
    start(): void {
        this.stop();
        this.lastAnswerAt = this.now();
        this.schedule(LIVENESS_PERIOD_MS);
    }

    /** No pipeline to ask (a state change, a stop): forget everything, say nothing. */
    stop(): void {
        this.epoch++;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.misses = 0;
        this.shown = false;
    }

    private now(): number {
        return (this.deps.now ?? Date.now)();
    }

    private schedule(delayMs: number): void {
        const epoch = this.epoch;
        this.timer = setTimeout(() => void this.tick(epoch), delayMs);
    }

    private async tick(epoch: number): Promise<void> {
        this.timer = null;
        const askedAt = this.now();
        let answer: boolean | null;
        try {
            answer = await this.deps.ask(LIVENESS_TIMEOUT_MS);
        } catch {
            answer = false;
        }
        if (epoch !== this.epoch) return;
        const now = this.now();
        if (answer !== false) {
            const silentS = Math.floor((now - this.lastAnswerAt) / 1000);
            this.misses = 0;
            this.lastAnswerAt = now;
            if (this.shown) {
                this.shown = false;
                this.deps.answered(silentS);
            }
            this.schedule(LIVENESS_PERIOD_MS);
            return;
        }
        this.misses++;
        if (this.misses >= LIVENESS_MISSES) {
            const silentS = Math.floor((now - this.lastAnswerAt) / 1000);
            this.shown = true;
            this.deps.stalled(notAnsweringText(silentS), silentS);
        }
        // At once after a timeout; a refusal that came sooner waits out the ask's budget.
        this.schedule(Math.max(0, askedAt + LIVENESS_TIMEOUT_MS - now));
    }
}
