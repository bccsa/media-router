const ignore = () => undefined;

/**
 * One read at a time (B-200): readers that come while it runs share it; its answer is kept for
 * `ttlMs`. A read older than an `invalidate()` answers only its own readers, the next starts when
 * it is done: reads never overlap, land in order, and none predates a reader's last invalidate.
 */
export class SharedRead<T> {
    private answer: { at: number; value: T } | null = null;
    private running: { generation: number; done: Promise<T> } | null = null;
    private generation = 0;

    constructor(
        private readonly read: () => Promise<T>,
        private readonly ttlMs: number,
        private readonly now: () => number = Date.now,
    ) {}

    get(): Promise<T> {
        const answer = this.answer;
        if (answer && this.ttlMs > 0 && this.now() - answer.at < this.ttlMs) {
            return Promise.resolve(answer.value);
        }
        const running = this.running;
        if (running && running.generation === this.generation) return running.done;
        const generation = this.generation;
        const done = (running ? running.done.then(ignore, ignore) : Promise.resolve())
            .then(() => this.read())
            .then((value) => {
                if (generation === this.generation) this.answer = { at: this.now(), value };
                return value;
            });
        const run = { generation, done };
        this.running = run;
        const settled = () => {
            if (this.running === run) this.running = null;
        };
        done.then(settled, settled);
        return done;
    }

    /** Forget the answer: the next reader gets a read that starts after this call. */
    invalidate(): void {
        this.answer = null;
        this.generation += 1;
    }
}
