import { describe, it, expect, beforeEach } from 'vitest';
import { BusChannelManager } from './BusChannelManager.js';

describe('BusChannelManager', () => {
    let mgr: BusChannelManager;

    beforeEach(() => {
        mgr = new BusChannelManager();
    });

    it('allocates unique ports per owner and is idempotent per owner', () => {
        const a = mgr.acquire('mod-a');
        const b = mgr.acquire('mod-b');
        expect(a).not.toBe(b);
        expect(mgr.acquire('mod-a')).toBe(a);
        expect(mgr.get('mod-a')).toBe(a);
    });

    it('re-acquires the same port after release — a module restart must not renumber ports its consumers are subscribed to', () => {
        const a = mgr.acquire('demux:pid-0x141');
        mgr.release('demux:pid-0x141');
        // Another owner allocating in between must not disturb the sticky slot.
        mgr.acquire('other');
        expect(mgr.acquire('demux:pid-0x141')).toBe(a);
    });

    it('keeps stickiness through releaseAllForOwner and changed allocation order', () => {
        const video = mgr.acquire('demux:pid-0x100');
        const audio = mgr.acquire('demux:pid-0x141');
        mgr.releaseAllForOwner('demux');
        // Rebuild allocates in a different order (a new stream sorts first) —
        // existing ports must still land where they were.
        mgr.acquire('demux:pid-0x140');
        expect(mgr.acquire('demux:pid-0x141')).toBe(audio);
        expect(mgr.acquire('demux:pid-0x100')).toBe(video);
    });

    it('fresh allocations skip released sticky slots, surrendering them only under pool pressure', () => {
        const small = new BusChannelManager(40000, 40001);
        expect(small.acquire('mod-a')).toBe(40000);
        small.release('mod-a');
        // Fresh owner skips mod-a's claimed slot while another port is free…
        expect(small.acquire('mod-b')).toBe(40001);
        // …but under pool pressure the stale claim is surrendered, not failed.
        expect(small.acquire('mod-c')).toBe(40000);
        // mod-a's stickiness is gone (evicted) and the pool is exhausted.
        expect(small.acquire('mod-a')).toBeNull();
    });
});
