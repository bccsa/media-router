import { describe, it, expect, vi } from 'vitest';
import { ModuleRunController } from './ModuleRunController.js';
import type { ModuleLifecycle } from './ModuleLifecycle.js';

interface Harness {
    controller: ModuleRunController;
    startAll: ReturnType<typeof vi.fn>;
    stopAll: ReturnType<typeof vi.fn>;
    onChange: ReturnType<typeof vi.fn>;
}

function makeController(
    overrides: { startAll?: () => Promise<void>; stopAll?: () => Promise<void> } = {},
): Harness {
    const startAll = vi.fn(overrides.startAll ?? (async () => {}));
    const stopAll = vi.fn(overrides.stopAll ?? (async () => {}));
    const onChange = vi.fn();
    const lifecycle = { startAll, stopAll } as unknown as ModuleLifecycle;
    return { controller: new ModuleRunController(lifecycle, onChange), startAll, stopAll, onChange };
}

describe('ModuleRunController', () => {
    it('starts in the stopped state', () => {
        const { controller } = makeController();
        expect(controller.isRunning).toBe(false);
    });

    describe('start()', () => {
        it('flips isRunning to true *before* awaiting startAll', async () => {
            // The whole point of intent-tracking: a patch handler that reads
            // isRunning while startAll is mid-flight must see the new value.
            // If the flag flipped after the await, freshly-added modules
            // arriving during start would be dropped.
            let observedDuringStartAll: boolean | null = null;
            const { controller } = makeController({
                startAll: async () => {
                    observedDuringStartAll = controller.isRunning;
                },
            });
            await controller.start();
            expect(observedDuringStartAll).toBe(true);
        });

        it('fires onChange(true) immediately — before startAll resolves', async () => {
            // onChange broadcasts run *intent*, not completion: waiting for
            // startAll left the LCP lagging a manager-initiated start by the
            // whole pipeline bring-up (10-20s) while manager browsers
            // updated instantly.
            const { controller, startAll, onChange } = makeController();
            await controller.start();
            expect(startAll).toHaveBeenCalledOnce();
            expect(onChange).toHaveBeenCalledExactlyOnceWith(true);
            expect(onChange.mock.invocationCallOrder[0]).toBeLessThan(
                startAll.mock.invocationCallOrder[0],
            );
        });

        it('rolls back isRunning and broadcasts the rollback when startAll throws', async () => {
            // The flag is reported to the manager via the engineRunningState
            // handshake — if we left it true after a failed startAll, the
            // manager would see "already running, just push config" forever
            // and never re-issue the start command. Roll back to false so
            // the next reconnect prompts a fresh start attempt, and broadcast
            // the rollback so the LCP's intent-first "running" is corrected.
            const err = new Error('start failed');
            const { controller, onChange } = makeController({
                startAll: async () => {
                    throw err;
                },
            });
            await expect(controller.start()).rejects.toThrow('start failed');
            expect(controller.isRunning).toBe(false);
            expect(onChange).toHaveBeenNthCalledWith(1, true);
            expect(onChange).toHaveBeenNthCalledWith(2, false);
        });

        it('reverts cleanly so a follow-up start() attempt can run startAll again', async () => {
            // The rollback makes retries meaningful — without it, `_running`
            // would short-circuit certain callers and a second start() call
            // wouldn't reach startAll at all.
            let calls = 0;
            const { controller, startAll } = makeController({
                startAll: async () => {
                    calls++;
                    if (calls === 1) throw new Error('first attempt failed');
                },
            });
            await expect(controller.start()).rejects.toThrow('first attempt failed');
            expect(controller.isRunning).toBe(false);
            await controller.start();
            expect(controller.isRunning).toBe(true);
            expect(startAll).toHaveBeenCalledTimes(2);
        });
    });

    describe('stop()', () => {
        it('flips isRunning to false *before* awaiting stopAll', async () => {
            let observedDuringStopAll: boolean | null = null;
            const { controller } = makeController({
                stopAll: async () => {
                    observedDuringStopAll = controller.isRunning;
                },
            });
            await controller.start();
            await controller.stop();
            expect(observedDuringStopAll).toBe(false);
        });

        it('fires onChange(false) immediately — before stopAll resolves', async () => {
            const { controller, stopAll, onChange } = makeController();
            await controller.start();
            onChange.mockClear();
            stopAll.mockClear();
            await controller.stop();
            expect(stopAll).toHaveBeenCalledOnce();
            expect(onChange).toHaveBeenCalledExactlyOnceWith(false);
            expect(onChange.mock.invocationCallOrder[0]).toBeLessThan(
                stopAll.mock.invocationCallOrder[0],
            );
        });

        it('preserves stopped intent on stopAll failure — broadcast already matches', async () => {
            const err = new Error('stop failed');
            const { controller, onChange } = makeController({
                stopAll: async () => {
                    throw err;
                },
            });
            await controller.start();
            onChange.mockClear();
            await expect(controller.stop()).rejects.toThrow('stop failed');
            expect(controller.isRunning).toBe(false);
            expect(onChange).toHaveBeenCalledExactlyOnceWith(false);
        });
    });
});
