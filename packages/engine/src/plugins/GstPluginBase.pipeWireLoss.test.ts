import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * B-195 (MR-021): a module's PipeWire stream lost under it reaches the device watchdog from
 * the base: a runner error the host marked `pipewire_lost`, or a capture whose meter stops while
 * PLAYING. Never a health error, never a loss for a silent input, and PLAYING adopts the daemon.
 */
const h = vi.hoisted(() => {
    class FakeChildProcess {
        static instances: FakeChildProcess[] = [];
        isRunning = false;
        private readonly handlers = new Map<string, Array<(data: unknown) => void>>();
        constructor() {
            FakeChildProcess.instances.push(this);
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
    return { FakeChildProcess };
});

vi.mock('../child-process/GstChildProcess.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../child-process/GstChildProcess.js')>()),
    GstChildProcess: h.FakeChildProcess,
}));

import { GstPluginBase } from './GstPluginBase.js';
import { PIPEWIRE_CAPTURE_STALL_MS } from './pipeWireLoss.js';
import type { PipelineDescription, ModuleServices } from './PluginModule.js';

const DEVICE = 'alsa_input.usb-Solid_State_Logic_SSL_2-00.HiFi__Mic1__source';

/** A capture as the 302M input is one: device watchdog, `level` behind the stream. */
class Capture extends GstPluginBase {
    protected readonly captureStallMs = PIPEWIRE_CAPTURE_STALL_MS;
    stopped = 0;
    buildPipeline(): PipelineDescription {
        return {
            pipeline: 'pipewiresrc name=capture ! level ! fakesink',
            pipeWireElements: ['capture'],
        };
    }
    async onStart(): Promise<void> {
        await super.onStart();
        this.startDeviceWatchdog();
    }
    protected getWatchedDeviceName(): string | null {
        return DEVICE;
    }
    protected async onDeviceDisconnected(): Promise<void> {
        this.stopped++;
        await super.onStop();
    }
    protected async onDeviceReconnected(): Promise<void> {
        await super.onStart();
    }
}

const pw = { present: true, up: true, cookie: 'a1' };
const child = () => h.FakeChildProcess.instances.at(-1)!;

async function started(watchdog = true) {
    const module = new Capture();
    await module.onInit({}, {
        instanceId: 'ain-1',
        ...(watchdog
            ? {
                  pipeWire: {
                      hasDevice: () => pw.up && pw.present,
                      daemonInstance: () => (pw.up ? pw.cookie : null),
                      isAvailable: () => pw.up,
                  },
              }
            : {}),
    } as unknown as ModuleServices);
    await module.onStart();
    child().emit('stateChange', { state: 'playing' });
    return module;
}

/** One meter reading a second for `seconds`, as the runner re-sends an unchanged (silent) one. */
async function meter(seconds: number, peak = [0, 0]) {
    for (let i = 0; i < seconds; i++) {
        child().emit('vuData', { peak });
        await vi.advanceTimersByTimeAsync(1000);
    }
}

beforeEach(() => {
    vi.useFakeTimers();
    h.FakeChildProcess.instances = [];
    Object.assign(pw, { present: true, up: true, cookie: 'a1' });
});
afterEach(() => vi.useRealTimers());

describe('GstPluginBase: a lost PipeWire stream (B-195)', () => {
    it('a pipewire_lost error is a warning naming it, a teardown and a rebuild, never a health error', async () => {
        const module = await started();
        const states: string[] = [];
        module.on('stateChange', (s: { health: string }) => states.push(s.health));
        child().emit('error', {
            kind: 'pipewire_lost',
            message: 'Disconnected: Connection terminated',
        });
        child().emit('stateChange', { state: 'error', kind: 'pipewire_lost' });
        await vi.advanceTimersByTimeAsync(0);
        expect(module.stopped).toBe(1);
        expect(module.getState()).toMatchObject({
            health: 'warning',
            error: 'PipeWire stream failed (Disconnected: Connection terminated) — rebuilding the stream once PipeWire and the device are back',
        });
        expect(states).not.toContain('error');
        await vi.advanceTimersByTimeAsync(2000);
        expect(h.FakeChildProcess.instances).toHaveLength(2);
        await module.onStop();
    });

    it('a capture whose meter stops while PLAYING is lost after the stall time, and rebuilt', async () => {
        const module = await started();
        await meter(3); // the last reading 1 s ago
        await vi.advanceTimersByTimeAsync(PIPEWIRE_CAPTURE_STALL_MS - 1000); // 4 s without one
        expect(module.stopped).toBe(0);
        await vi.advanceTimersByTimeAsync(1000);
        expect(module.stopped).toBe(1);
        expect(module.getState().error).toBe(
            'No audio from the capture for 5 s — rebuilding the stream once PipeWire and the device are back',
        );
        await vi.advanceTimersByTimeAsync(2000);
        expect(h.FakeChildProcess.instances).toHaveLength(2);
        await module.onStop();
    });

    it('a capture that delivers nothing after PLAYING is lost too: PLAYING arms the stall', async () => {
        const module = await started();
        await vi.advanceTimersByTimeAsync(PIPEWIRE_CAPTURE_STALL_MS);
        expect(module.stopped).toBe(0);
        await vi.advanceTimersByTimeAsync(1000);
        expect(module.stopped).toBe(1);
        await module.onStop();
    });

    it('a silent input still delivers buffers: a minute of silence is never a loss', async () => {
        const module = await started();
        await meter(60);
        expect(module.stopped).toBe(0);
        expect(h.FakeChildProcess.instances).toHaveLength(1);
        await module.onStop();
    });

    it('the stall counts only while PLAYING: a runner restarting after another error is not a loss', async () => {
        const module = await started();
        await meter(2);
        child().emit('stateChange', { state: 'error' });
        await vi.advanceTimersByTimeAsync(3 * PIPEWIRE_CAPTURE_STALL_MS);
        expect(module.stopped).toBe(0);
        await module.onStop();
    });

    it('PLAYING adopts the daemon: a runner that restarted on the new one is not rebuilt again', async () => {
        const module = await started();
        pw.cookie = 'b2';
        child().emit('stateChange', { state: 'playing' });
        await meter(10);
        expect(module.stopped).toBe(0);
        await module.onStop();
    });

    it('without a watchdog the cause stands as a health error', async () => {
        const module = await started(false);
        child().emit('error', { kind: 'pipewire_lost', message: 'Disconnected' });
        expect(module.getState()).toMatchObject({
            health: 'error',
            error: 'PipeWire stream failed (Disconnected)',
        });
        await module.onStop();
    });
});
