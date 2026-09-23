import { describe, it, expect } from 'vitest';
import { RistFlowTracker, peerRtt } from './ristFlowTracker.js';

const peer = (id: number, dead = 0, stats: Record<string, unknown> = { avg_rtt: 5 }) => ({
    id,
    dead,
    stats,
});
const flow = (
    flow_id: number,
    peers: unknown[],
    stats: Record<string, unknown> = {},
    dead = 0,
) => ({
    flow_id,
    dead,
    stats: { received: 10, missing: 1, quality: 95, ...stats },
    peers,
});

describe('RistFlowTracker', () => {
    it('ignores a payload without stats', () => {
        const t = new RistFlowTracker();
        expect(t.observe({ flow_id: 1, peers: [peer(1)] }, 0)).toBe(false);
        expect(t.livePeers()).toEqual([]);
    });

    it('unions live peers across flows and drops dead ones', () => {
        const t = new RistFlowTracker();
        t.observe(flow(11, [peer(1), peer(2, 1)]), 0);
        t.observe(flow(22, [peer(7)]), 0);
        expect(t.livePeers().map((p) => p.id)).toEqual([1, 7]);
    });

    it('replaces a flow window on its next report instead of accumulating', () => {
        const t = new RistFlowTracker();
        t.observe(flow(11, [peer(1), peer(2)]), 0);
        t.observe(flow(11, [peer(3)]), 1000);
        expect(t.livePeers().map((p) => p.id)).toEqual([3]);
    });

    it('forgets a flow on the dead=2 session-timeout farewell', () => {
        const t = new RistFlowTracker();
        t.observe(flow(11, [peer(1)]), 0);
        t.observe(flow(11, [peer(1)], {}, 2), 1000);
        expect(t.livePeers()).toEqual([]);
    });

    it('sweeps flows silent for longer than staleMs', () => {
        const t = new RistFlowTracker();
        t.observe(flow(11, [peer(1)]), 0);
        t.observe(flow(22, [peer(7)]), 2500);
        expect(t.sweep(3200, 3000)).toBe(true);
        expect(t.livePeers().map((p) => p.id)).toEqual([7]);
        expect(t.sweep(3300, 3000)).toBe(false);
    });

    it('sums counters across flows and reports the worst quality', () => {
        const t = new RistFlowTracker();
        t.observe(
            flow(11, [], {
                received: 100,
                missing: 5,
                dropped_late: 1,
                recovered_total: 4,
                lost: 2,
                quality: 99,
            }),
            0,
        );
        t.observe(
            flow(22, [], {
                received: 50,
                missing: 0,
                dropped_late: 0,
                recovered_total: 0,
                lost: 0,
                quality: 80,
            }),
            0,
        );
        expect(t.counters()).toEqual({
            received: 150,
            missing: 5,
            dropped: 1,
            recovered: 4,
            lost: 2,
            quality: 80,
        });
    });

    it('reports quality 0 with no flows at all', () => {
        expect(new RistFlowTracker().counters().quality).toBe(0);
    });

    it('keys payloads without a numeric flow_id into one shared slot', () => {
        const t = new RistFlowTracker();
        t.observe({ stats: {}, peers: [peer(1)] }, 0);
        t.observe({ stats: {}, peers: [peer(2)] }, 0);
        expect(t.livePeers().map((p) => p.id)).toEqual([2]);
    });

    it('formats the RTT of a peer or a dash', () => {
        expect(peerRtt(peer(1, 0, { avg_rtt: 14.456 }))).toBe('14.46');
        expect(peerRtt(peer(1, 0, { rtt: 9 }))).toBe('9');
        expect(peerRtt(undefined)).toBe('—');
    });
});
