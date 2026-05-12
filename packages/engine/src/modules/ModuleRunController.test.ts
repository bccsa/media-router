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

        it('fires onChange(true) only after a successful startAll', async () => {
            const { controller, startAll, onChange } = makeController();
            await controller.start();
            expect(startAll).toHaveBeenCalledOnce();
            expect(onChange).toHaveBeenCalledExactlyOnceWith(true);
            // onChange must fire after startAll resolves, not before.
            expect(startAll.mock.invocationCallOrder[0]).toBeLessThan(
                onChange.mock.invocationCallOrder[0],
            );
        });

        it('preserves intent on startAll failure but does NOT broadcast', async () => {
            // Intent survives a failure so a future retry/reset still knows
            // what the user asked for. But the broadcast tracks observable
            // state — telling the LCP "running" when startAll threw would
            // misrepresent reality.
            const err = new Error('start failed');
            const { controller, onChange } = makeController({
                startAll: async () => {
                    throw err;
                },
            });
            await expect(controller.start()).rejects.toThrow('start failed');
            expect(controller.isRunning).toBe(true);
            expect(onChange).not.toHaveBeenCalled();
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

        it('fires onChange(false) only after a successful stopAll', async () => {
            const { controller, stopAll, onChange } = makeController();
            await controller.start();
            onChange.mockClear();
            await controller.stop();
            expect(stopAll).toHaveBeenCalledOnce();
            expect(onChange).toHaveBeenCalledExactlyOnceWith(false);
            expect(stopAll.mock.invocationCallOrder[0]).toBeLessThan(
                onChange.mock.invocationCallOrder[0],
            );
        });

        it('preserves stopped intent on stopAll failure but does NOT broadcast', async () => {
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
            expect(onChange).not.toHaveBeenCalled();
        });
    });
});
