/**
 * Shared helpers for SRT input/output plugins.
 *
 * Extracted from the previously-duplicated bodies of `SrtInputModule.pollStats`
 * and `SrtOutputModule.pollStats` — same per-caller delta tracking, packet-loss
 * EMA, dynamic-section generation, and badge state machine, parameterised by
 * direction so input (receive) and output (send) read the right stat keys.
 */

/** Format a raw byte count with adaptive units (B / KB / MB / GB). */
export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

type Badge = { icon?: string; text: string; color?: string };
type StatusSection = {
    id: string;
    label: string;
    fields: Array<{ key: string; label: string; unit?: string }>;
};

/**
 * Callbacks the poller uses to push state into the host plugin. The plugin
 * binds these to its `setStatusData` / `setBadge` / `clearBadge` and the
 * `dynamicStatusSections` setter; the poller treats the plugin as an opaque
 * sink so it doesn't need access to `GstPluginBase`'s protected surface.
 */
export interface SrtStatPollerHost {
    isRunning(): boolean;
    getElementStats(): Promise<Record<string, unknown> | undefined>;
    setStatusData(section: string, data: Record<string, unknown>): void;
    setBadge(id: string, badge: Badge): void;
    clearBadge(id: string): void;
    setSections(sections: StatusSection[]): void;
}

export type SrtDirection = 'send' | 'receive';

interface CallerTracker {
    prevLost: number;
    prevTotal: number;
    lossAvg: number;
}

/** Per-direction stat-key map; `srtsrc` and `srtsink` use different names. */
function keysFor(direction: SrtDirection): {
    bytes: string;
    bytesTotal: string;
    packets: string;
    packetsLost: string;
    bitrate: string;
    statusField: string;
    statusFieldLabel: string;
} {
    return direction === 'receive'
        ? {
              bytes: 'bytes-received',
              bytesTotal: 'bytes-received-total',
              packets: 'packets-received',
              packetsLost: 'packets-received-lost',
              bitrate: 'receive-rate-mbps',
              statusField: 'bytesReceived',
              statusFieldLabel: 'Bytes Received',
          }
        : {
              bytes: 'bytes-sent',
              bytesTotal: 'bytes-sent-total',
              packets: 'packets-sent',
              packetsLost: 'packets-sent-lost',
              bitrate: 'send-rate-mbps',
              statusField: 'bytesSent',
              statusFieldLabel: 'Bytes Sent',
          };
}

/**
 * Drives per-caller stat polling for one SRT plugin instance. The host calls
 * `poll()` on a timer; the poller reads stats from `host.getElementStats()`,
 * computes deltas, smooths packet loss with an EMA, and updates the host's
 * badges + dynamic status sections.
 *
 * Listener mode is detected by the *presence* of a `callers` array in the
 * stats payload (empty array still counts as listener — that fixes a dead-
 * code branch in the original plugins where listener-with-zero-callers
 * surfaced as a misleading "Connecting" badge instead of "Waiting").
 */
export class SrtStatPoller {
    private callerStats = new Map<number, CallerTracker>();
    private lastBytes = 0;
    private readonly keys: ReturnType<typeof keysFor>;
    private readonly callerFields: StatusSection['fields'];

    constructor(
        private readonly host: SrtStatPollerHost,
        private readonly direction: SrtDirection,
    ) {
        this.keys = keysFor(direction);
        this.callerFields = [
            { key: 'bitrate', label: 'Bitrate', unit: 'Mbps' },
            { key: 'rtt', label: 'RTT', unit: 'ms' },
            { key: 'packetLoss', label: 'Packet Loss' },
            { key: this.keys.statusField, label: this.keys.statusFieldLabel },
        ];
    }

    /** Reset internal state — call on pipeline restart so old deltas don't leak. */
    reset(): void {
        this.callerStats.clear();
        this.lastBytes = 0;
    }

    /** Read one set of stats and update the host. Safe to call when not running. */
    async poll(): Promise<void> {
        if (!this.host.isRunning()) return;
        try {
            const stats = await this.host.getElementStats();
            if (!stats) return;
            const callers = stats['callers'] as Array<Record<string, unknown>> | undefined;
            // Listener mode is detected by the *presence* of the callers array,
            // not by length — an empty `callers: []` means listener with no
            // peers (legitimate "Waiting" state), not caller mode.
            if (callers !== undefined) {
                this.handleListenerMode(callers);
            } else {
                this.handleCallerMode(stats);
            }
        } catch {
            /* best-effort polling */
        }
    }

    private handleListenerMode(callers: Array<Record<string, unknown>>): void {
        const sections: StatusSection[] = [];
        for (let i = 0; i < callers.length; i++) {
            sections.push({
                id: `caller-${i}`,
                label: `Caller ${i + 1}`,
                fields: this.callerFields,
            });
            this.host.setStatusData(`caller-${i}`, this.computeCallerFields(callers[i], i));
        }
        this.host.setSections(sections);

        // Drop trackers for callers that disappeared
        for (const [idx] of this.callerStats) {
            if (idx >= callers.length) this.callerStats.delete(idx);
        }

        const callerCount = callers.length;
        this.host.setStatusData('stats', { callers: callerCount });
        this.host.setBadge('callers', {
            icon: 'users',
            text: String(callerCount),
            color: callerCount > 0 ? '#10b981' : '#6b7280',
        });
        if (callerCount === 0) {
            this.host.setBadge('status', { icon: 'radio', text: 'Waiting', color: '#6b7280' });
        } else {
            this.host.clearBadge('status');
        }
    }

    private handleCallerMode(stats: Record<string, unknown>): void {
        const fields = this.computeCallerFields(stats, 0);

        const rawBytes = Number(stats[this.keys.bytesTotal] ?? stats[this.keys.bytes] ?? 0);
        const isActive = rawBytes > 0 && rawBytes > this.lastBytes;
        this.lastBytes = rawBytes;

        this.host.setSections([]);
        this.host.setStatusData('stats', {
            ...fields,
            callers: '—',
        });
        if (isActive) {
            this.host.setBadge('status', { icon: 'radio', text: 'Connected', color: '#10b981' });
        } else {
            this.host.setBadge('status', {
                icon: 'radio',
                text: rawBytes > 0 ? 'Stalled' : 'Connecting',
                color: '#f59e0b',
            });
        }
        this.host.clearBadge('callers');
    }

    /**
     * Compute the per-caller field bundle (bitrate / rtt / packetLoss / bytes)
     * and side-effect into the loss-EMA tracker for this caller index.
     */
    private computeCallerFields(c: Record<string, unknown>, idx: number): Record<string, unknown> {
        let tracker = this.callerStats.get(idx);
        if (!tracker) {
            tracker = { prevLost: 0, prevTotal: 0, lossAvg: 0 };
            this.callerStats.set(idx, tracker);
        }

        const rtt = (c['rtt-ms'] ?? '—') as string | number;
        const bitrate = (c[this.keys.bitrate] ?? c['bandwidth-mbps'] ?? '—') as string | number;
        const rawBytes = Number(c[this.keys.bytes] ?? 0);
        const bytesFormatted = rawBytes > 0 ? formatBytes(rawBytes) : '—';

        const currLost = Number(c[this.keys.packetsLost] ?? 0);
        const currTotal = Number(c[this.keys.packets] ?? 0);
        const deltaLost = currLost - tracker.prevLost;
        const deltaTotal = currTotal - tracker.prevTotal;
        let packetLoss: string | number = '—';

        if (deltaTotal > 0) {
            // Smooth the instantaneous loss with an EMA so a single delivery
            // hiccup doesn't spike the badge from green to red — the smoothing
            // weight (0.7 prev / 0.3 new) was chosen by feel during v1 work.
            const instantLoss = (deltaLost / (deltaTotal + deltaLost)) * 100;
            tracker.lossAvg = tracker.lossAvg * 0.7 + instantLoss * 0.3;
            packetLoss = `${tracker.lossAvg.toFixed(2)}%`;
        } else if (tracker.prevTotal > 0) {
            packetLoss = `${tracker.lossAvg.toFixed(2)}%`;
        }

        tracker.prevLost = currLost;
        tracker.prevTotal = currTotal;

        return {
            bitrate,
            rtt,
            packetLoss,
            [this.keys.statusField]: bytesFormatted,
        };
    }
}
