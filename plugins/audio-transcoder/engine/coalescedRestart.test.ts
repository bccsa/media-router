import { describe, it, expect, vi } from 'vitest';
import { CoalescedRestart } from './coalescedRestart.js';

/** Deferred cycle so a trigger can be held mid-flight. */
function deferred<T = void>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

describe('CoalescedRestart', () => {
    it('runs one cycle per trigger while nothing overlaps', async () => {
        const cycle = vi.fn(async () => {});
        const driver = new CoalescedRestart({ cycle });

        await driver.trigger();
        await driver.trigger();

        expect(cycle).toHaveBeenCalledTimes(2);
        expect(driver.inFlight).toBe(false);
    });

    it('collapses a burst of mid-cycle triggers into exactly ONE follow-up', async () => {
        const held = deferred();
        const cycle = vi.fn(() => held.promise);
        const driver = new CoalescedRestart({ cycle });

        const first = driver.trigger();
        expect(driver.inFlight).toBe(true);
        // Three triggers while cycle 1 is in flight → one queued cycle, not three.
        void driver.trigger();
        void driver.trigger();
        void driver.trigger();
        cycle.mockResolvedValue(undefined);
        held.resolve();
        await first;

        expect(cycle).toHaveBeenCalledTimes(2);
        expect(driver.inFlight).toBe(false);
    });

    it('a queued trigger resolves immediately — it does not wait for its cycle', async () => {
        const held = deferred();
        const driver = new CoalescedRestart({ cycle: () => held.promise });

        const first = driver.trigger();
        const queued = driver.trigger();
        await expect(queued).resolves.toBeUndefined(); // cycle 1 is still parked
        expect(driver.inFlight).toBe(true);

        held.resolve();
        await first;
    });

    it('reports a throwing cycle via onError without rejecting the trigger', async () => {
        const boom = new Error('teardown failed');
        const onError = vi.fn();
        const driver = new CoalescedRestart({
            cycle: async () => {
                throw boom;
            },
            onError,
        });

        await expect(driver.trigger()).resolves.toBeUndefined();
        expect(onError).toHaveBeenCalledWith(boom);
        expect(driver.inFlight).toBe(false);
    });

    it('still runs the queued follow-up after a cycle throws', async () => {
        const held = deferred();
        const cycle = vi.fn(() => held.promise);
        const onError = vi.fn();
        const driver = new CoalescedRestart({ cycle, onError });

        const first = driver.trigger();
        void driver.trigger(); // queued while cycle 1 is parked
        cycle.mockResolvedValue(undefined);
        held.reject(new Error('boom'));
        await first;

        expect(onError).toHaveBeenCalledTimes(1);
        expect(cycle).toHaveBeenCalledTimes(2); // the failure did not cancel it
    });

    it('a cycle that throws leaves the latch clear for the next trigger', async () => {
        const cycle = vi.fn(async () => {
            throw new Error('boom');
        });
        const driver = new CoalescedRestart({ cycle, onError: () => {} });

        await driver.trigger();
        await driver.trigger();

        expect(cycle).toHaveBeenCalledTimes(2);
    });
});
