import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GstPluginBase } from './GstPluginBase.js';
import type { PipelineDescription } from './PluginModule.js';

/**
 * The base-class wrappers around childProcess live-control calls (setProperty
 * etc.) must swallow RPC failures so plugin authors keep a fire-and-forget
 * contract. Without this, a stale element name surfaces as a thrown Error in
 * plugin code that used to silently succeed before the command_error split.
 */
class TestModule extends GstPluginBase {
    buildPipeline(): PipelineDescription | null {
        return null;
    }
}

const makeFakeChildProcess = (
    behavior: Record<string, () => Promise<unknown>>,
): { isRunning: boolean } & Record<string, unknown> => ({
    isRunning: true,
    setProperty: vi.fn(behavior.setProperty ?? (async () => undefined)),
    getProperty: vi.fn(behavior.getProperty ?? (async () => 'ok')),
    getStats: vi.fn(behavior.getStats ?? (async () => ({}))),
    trackThroughput: vi.fn(behavior.trackThroughput ?? (async () => undefined)),
    getThroughput: vi.fn(behavior.getThroughput ?? (async () => ({}))),
});

const callProtected = async <T,>(mod: TestModule, name: string, ...args: unknown[]): Promise<T> => {
    return (mod as unknown as Record<string, (...args: unknown[]) => Promise<T>>)[name](...args);
};

describe('GstPluginBase live-control wrappers — swallow RPC failures', () => {
    let mod: TestModule;
    let debugSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        mod = new TestModule();
        debugSpy = vi.fn();
        // Replace the per-instance logger with a spy
        (mod as unknown as { log: { debug: typeof debugSpy } }).log = {
            debug: debugSpy,
        } as unknown as (typeof mod)['log'];
    });

    it('setElementProperty: resolves and logs at debug when childProcess throws', async () => {
        (mod as unknown as { childProcess: unknown }).childProcess = makeFakeChildProcess({
            setProperty: async () => {
                throw new Error('setProperty(nov.text): Element not found: nov');
            },
        });

        await expect(
            callProtected<void>(mod, 'setElementProperty', 'nov', 'text', 'hi'),
        ).resolves.toBeUndefined();
        expect(debugSpy).toHaveBeenCalledOnce();
        const [ctx, msg] = debugSpy.mock.calls[0];
        expect((ctx as { element: string }).element).toBe('nov');
        expect(msg).toMatch(/setElementProperty failed/);
    });

    it('getElementProperty: returns undefined when childProcess throws', async () => {
        (mod as unknown as { childProcess: unknown }).childProcess = makeFakeChildProcess({
            getProperty: async () => {
                throw new Error('command_error');
            },
        });

        const result = await callProtected(mod, 'getElementProperty', 'el', 'p');
        expect(result).toBeUndefined();
        expect(debugSpy).toHaveBeenCalledOnce();
    });

    it('getElementStats: returns empty dict when childProcess throws', async () => {
        (mod as unknown as { childProcess: unknown }).childProcess = makeFakeChildProcess({
            getStats: async () => {
                throw new Error('Element not found');
            },
        });

        const result = await callProtected(mod, 'getElementStats', 'srtsrc');
        expect(result).toEqual({});
        expect(debugSpy).toHaveBeenCalledOnce();
    });

    it('trackThroughput / getThroughput also swallow', async () => {
        (mod as unknown as { childProcess: unknown }).childProcess = makeFakeChildProcess({
            trackThroughput: async () => {
                throw new Error('boom');
            },
            getThroughput: async () => {
                throw new Error('boom');
            },
        });

        await expect(callProtected<void>(mod, 'trackThroughput', 'el')).resolves.toBeUndefined();
        await expect(callProtected(mod, 'getThroughput')).resolves.toEqual({});
        expect(debugSpy).toHaveBeenCalledTimes(2);
    });

    it('no childProcess: returns the same fallbacks as the old code path', async () => {
        await expect(
            callProtected<void>(mod, 'setElementProperty', 'el', 'p', 1),
        ).resolves.toBeUndefined();
        await expect(callProtected(mod, 'getElementProperty', 'el', 'p')).resolves.toBeUndefined();
        await expect(callProtected(mod, 'getElementStats', 'el')).resolves.toEqual({});
        await expect(callProtected(mod, 'getThroughput')).resolves.toEqual({});
        // No log calls because we never reached the try/catch
        expect(debugSpy).not.toHaveBeenCalled();
    });
});
