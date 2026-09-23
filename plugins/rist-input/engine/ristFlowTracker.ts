/**
 * Tracks librist receiver flows for the RIST input card.
 *
 * librist posts receiver stats one message PER FLOW, and a listener can hold
 * several flows at once: two senders, or a restarted sender whose old flow
 * lingers until its session timeout. Rendering straight from each message
 * would thrash the card between flows (the original #682 symptom, 2 of 3
 * links), so this keeps the latest window of every fresh flow and answers
 * aggregate questions: which peers are live, and the flow counters summed.
 */

/** One entry of librist's receiver `flowinstant.peers[]`. */
export interface RistPeer {
    id?: number;
    dead?: number | boolean;
    stats?: Record<string, unknown>;
}

/** `flowinstant.stats` counters the card shows. */
export interface RistFlowCounters {
    received: number;
    missing: number;
    dropped: number;
    recovered: number;
    lost: number;
    quality: number;
}

/** librist's `flow.dead`: 0 alive, 1 no data past flow_timeout, 2 session-timeout farewell. */
export const FLOW_DEAD_SESSION_TIMEOUT = 2;

/** Key for a payload without a numeric `flow_id` (legacy python path, tests):
 *  every such payload shares one slot, i.e. last-message-wins as before. */
const UNKEYED_FLOW = -1;

interface FlowWindow {
    peers: RistPeer[];
    counters: RistFlowCounters;
    seenAt: number;
}

export class RistFlowTracker {
    private flows = new Map<number, FlowWindow>();

    reset(): void {
        this.flows.clear();
    }

    /** Record one `flowinstant` payload. Returns false when it carried no stats. */
    observe(flow: Record<string, any>, now: number): boolean {
        const s = flow?.stats;
        if (!s) return false;
        const key = typeof flow.flow_id === 'number' ? flow.flow_id : UNKEYED_FLOW;
        if (Number(flow.dead) === FLOW_DEAD_SESSION_TIMEOUT) {
            this.flows.delete(key);
            return true;
        }
        const peers = (Array.isArray(flow.peers) ? flow.peers : []) as RistPeer[];
        this.flows.set(key, {
            // Dead peers stay in librist's list (≈5 s for listener children,
            // forever for a caller-mode input) — never a connection.
            peers: peers.filter((p) => !p.dead),
            counters: {
                received: Number(s.received ?? 0),
                missing: Number(s.missing ?? 0),
                dropped: Number(s.dropped_late ?? 0),
                recovered: Number(s.recovered_total ?? 0),
                lost: Number(s.lost ?? 0),
                quality: Number(s.quality ?? 0),
            },
            seenAt: now,
        });
        return true;
    }

    /** Forget flows silent for longer than `staleMs`. Returns true if any went. */
    sweep(now: number, staleMs: number): boolean {
        let dropped = false;
        for (const [key, f] of this.flows) {
            if (now - f.seenAt > staleMs) {
                this.flows.delete(key);
                dropped = true;
            }
        }
        return dropped;
    }

    /** Live peers across every fresh flow. Peer ids are unique per librist ctx. */
    livePeers(): RistPeer[] {
        return [...this.flows.values()].flatMap((f) => f.peers);
    }

    /** Flow counters summed across fresh flows; quality is the worst flow's. */
    counters(): RistFlowCounters {
        const total: RistFlowCounters = {
            received: 0,
            missing: 0,
            dropped: 0,
            recovered: 0,
            lost: 0,
            quality: 100,
        };
        let any = false;
        for (const f of this.flows.values()) {
            any = true;
            total.received += f.counters.received;
            total.missing += f.counters.missing;
            total.dropped += f.counters.dropped;
            total.recovered += f.counters.recovered;
            total.lost += f.counters.lost;
            total.quality = Math.min(total.quality, f.counters.quality);
        }
        if (!any) total.quality = 0;
        return total;
    }
}

/** Averaged RTT of the first live peer as the card prints it, `—` when none. */
export function peerRtt(peer: RistPeer | undefined): string {
    const p = peer?.stats;
    if (typeof p?.avg_rtt === 'number') return (p.avg_rtt as number).toFixed(2);
    return p?.rtt !== undefined ? String(p.rtt) : '—';
}
