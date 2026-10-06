/**
 * Test double for `GstChildProcess` — the test plays the runner by emitting
 * its events (`stateChange`, `pluginEvent`, `busGate`, `error`, …) into the
 * handlers `GstPluginBase.onStart` registered. Install per test file with:
 *
 *     vi.mock('../child-process/GstChildProcess.js', async (importOriginal) => ({
 *         ...(await importOriginal<typeof import('../child-process/GstChildProcess.js')>()),
 *         GstChildProcess: (await import('./testing/FakeGstChildProcess.js')).FakeGstChildProcess,
 *     }));
 */
export class FakeGstChildProcess {
    static instances: FakeGstChildProcess[] = [];
    isRunning = false;
    private readonly handlers = new Map<string, Array<(data: unknown) => void>>();

    constructor() {
        FakeGstChildProcess.instances.push(this);
    }

    on(event: string, fn: (data: unknown) => void): this {
        const list = this.handlers.get(event) ?? [];
        list.push(fn);
        this.handlers.set(event, list);
        return this;
    }

    emit(event: string, data?: unknown): void {
        for (const fn of this.handlers.get(event) ?? []) fn(data);
    }

    async start(): Promise<void> {
        this.isRunning = true;
    }

    async stop(): Promise<void> {
        this.isRunning = false;
    }

    async destroy(): Promise<void> {
        this.isRunning = false;
    }

    async updatePipelineDesc(): Promise<void> {}
}
