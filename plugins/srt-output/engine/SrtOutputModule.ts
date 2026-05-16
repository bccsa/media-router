import {
    GstPluginBase,
    buildLeakyQueue,
    buildUdpSrc,
    type PipelineDescription,
    type ModuleServices,
} from '@media-router/engine';

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * SRT Output plugin.
 *
 * Receives local MPEG-TS via UDP multicast and sends it over the network
 * via SRT. Pure MPEG-TS passthrough — no encoding or processing.
 *
 * Supports listener (accept pullers) and caller (push to remote) modes.
 * Optional AES encryption via passphrase.
 */
export class SrtOutputModule extends GstPluginBase {
    private statsTimer: ReturnType<typeof setInterval> | null = null;
    // Per-caller delta tracking for packet loss
    private callerStats = new Map<
        number,
        { prevLost: number; prevSent: number; lossAvg: number }
    >();
    /** Previous bytes-sent total — used to detect stalled connections in caller mode. */
    private lastSentBytes = 0;

    async onStart(): Promise<void> {
        await super.onStart();

        // Reflect pipeline outages immediately. pollStats only runs while the
        // pipeline is playing, so without this hook a "Connected" badge from
        // the last good poll lingers across the 5s–10s restart-backoff window
        // (and srtsink bus-errors briefly flip health=error to health=stopped,
        // which made the UI flash red while still showing "Connected").
        this.childProcess?.on('stateChange', (data: { state: string }) => {
            if (data.state === 'stopped' || data.state === 'error') {
                this.setBadge('status', {
                    icon: 'radio',
                    text: 'Connecting',
                    color: '#f59e0b',
                });
                this.clearBadge('callers');
                this.dynamicStatusSections = [];
                this.lastSentBytes = 0;
                this.callerStats.clear();
            }
        });

        // Start polling SRT stats
        this.statsTimer = setInterval(() => this.pollStats(), 2000);
        this.updateStatusData();
    }

    async onStop(): Promise<void> {
        if (this.statsTimer) {
            clearInterval(this.statsTimer);
            this.statsTimer = null;
        }
        await super.onStop();
    }

    buildPipeline(config: Record<string, unknown>): PipelineDescription | null {
        const host = (config.host as string) ?? '0.0.0.0';
        const port = (config.port as number) ?? 9000;
        const mode = (config.mode as string) ?? 'caller';
        const latency = (config.latency as number) ?? 125;
        const streamId = (config.streamId as string) ?? '';
        const passphrase = (config.passphrase as string) ?? '';
        const pbKeyLen = (config.pbKeyLen as number) ?? 0;

        // Get the UDP source from the connected encoder/srt-input
        const instanceId = this.services?.instanceId ?? '';
        const udpSource = this.services?.mediaRouter?.getModuleUdpSource(instanceId);
        if (!udpSource) {
            this.log.info('No MPEG-TS source connected — idle');
            return null;
        }

        // Build SRT URI
        let uri = `srt://${host}:${port}`;
        const params: string[] = [`mode=${mode}`, `latency=${latency}`];
        if (streamId) params.push(`streamid=${streamId}`);
        if (passphrase) params.push(`passphrase=${passphrase}`);
        if (pbKeyLen > 0) params.push(`pbkeylen=${pbKeyLen}`);
        uri += '?' + params.join('&');

        // auto-reconnect=false: libsrt's built-in retry loop spawns a new SRT
        // socket (+ SndQ/RcvQ worker threads) every ~1s while the remote is
        // unreachable, which pegs CPU. Letting srtsink emit the bus error
        // instead routes reconnects through restartBackoffMs. Cap is kept
        // tight (10s) — unlike a transient crash, an unreachable SRT peer
        // gains nothing from longer backoff: we don't know when it returns,
        // so retrying often is what feels snappy when it finally does.
        const pipeline = [
            buildUdpSrc({ host: udpSource.host, port: udpSource.port }),
            buildLeakyQueue(100),
            `srtsink name=sink uri="${uri}" sync=false wait-for-connection=false auto-reconnect=false`,
        ].join(' ! ');

        return {
            pipeline,
            restartOnError: true,
            restartBackoffMs: { baseMs: 5000, maxMs: 10000 },
        };
    }

    private async pollStats(): Promise<void> {
        if (!this.running) return;
        try {
            const stats = await this.getElementStats('sink');
            if (!stats) return;

            const callers = stats['callers'] as Array<Record<string, unknown>> | undefined;
            const callerCount = callers?.length ?? 0;

            if (callers && callers.length > 0) {
                // Listener mode — per-caller stats as dynamic sections
                const sections: Array<{
                    id: string;
                    label: string;
                    fields: Array<{ key: string; label: string; unit?: string }>;
                }> = [];
                const callerFields = [
                    { key: 'bitrate', label: 'Bitrate', unit: 'Mbps' },
                    { key: 'rtt', label: 'RTT', unit: 'ms' },
                    { key: 'packetLoss', label: 'Packet Loss' },
                    { key: 'bytesSent', label: 'Bytes Sent' },
                ];

                for (let i = 0; i < callers.length; i++) {
                    const c = callers[i];
                    const sectionId = `caller-${i}`;
                    sections.push({
                        id: sectionId,
                        label: `Caller ${i + 1}`,
                        fields: callerFields,
                    });

                    // Get or create per-caller tracking
                    if (!this.callerStats.has(i)) {
                        this.callerStats.set(i, { prevLost: 0, prevSent: 0, lossAvg: 0 });
                    }
                    const tracker = this.callerStats.get(i)!;

                    const rtt = (c['rtt-ms'] ?? '—') as string | number;
                    const bitrate = (c['send-rate-mbps'] ?? c['bandwidth-mbps'] ?? '—') as
                        | string
                        | number;
                    const rawBytes = Number(c['bytes-sent'] ?? 0);
                    const bytesSent = rawBytes > 0 ? formatBytes(rawBytes) : '—';

                    const currLost = Number(c['packets-sent-lost'] ?? 0);
                    const currSent = Number(c['packets-sent'] ?? 0);
                    const deltaLost = currLost - tracker.prevLost;
                    const deltaSent = currSent - tracker.prevSent;
                    let packetLoss: string | number = '—';

                    if (deltaSent > 0) {
                        const instantLoss = (deltaLost / (deltaSent + deltaLost)) * 100;
                        tracker.lossAvg = tracker.lossAvg * 0.7 + instantLoss * 0.3;
                        packetLoss = `${tracker.lossAvg.toFixed(2)}%`;
                    } else if (tracker.prevSent > 0) {
                        packetLoss = `${tracker.lossAvg.toFixed(2)}%`;
                    }

                    tracker.prevLost = currLost;
                    tracker.prevSent = currSent;

                    this.setStatusData(sectionId, { bitrate, rtt, packetLoss, bytesSent });
                }

                // Update dynamic sections and summary
                this.dynamicStatusSections = sections;
                this.setStatusData('stats', { callers: callerCount });
                this.setBadge('callers', {
                    icon: 'users',
                    text: String(callerCount),
                    color: callerCount > 0 ? '#10b981' : '#6b7280',
                });
                if (callerCount === 0) {
                    this.setBadge('status', { icon: 'radio', text: 'Waiting', color: '#6b7280' });
                } else {
                    this.clearBadge('status');
                }

                // Clean up stale caller trackers
                for (const [idx] of this.callerStats) {
                    if (idx >= callers.length) this.callerStats.delete(idx);
                }
            } else {
                // Caller mode — check if actually sending by looking at bytes delta
                const c = stats;
                const rtt = (c['rtt-ms'] ?? '—') as string | number;
                const bitrate = (c['send-rate-mbps'] ?? c['bandwidth-mbps'] ?? '—') as
                    | string
                    | number;
                const rawBytes = Number(c['bytes-sent'] ?? stats['bytes-sent-total'] ?? 0);
                const bytesSent = rawBytes > 0 ? formatBytes(rawBytes) : '—';
                const prevBytes = this.lastSentBytes;
                const isSending = rawBytes > 0 && rawBytes > prevBytes;
                this.lastSentBytes = rawBytes;

                if (!this.callerStats.has(0)) {
                    this.callerStats.set(0, { prevLost: 0, prevSent: 0, lossAvg: 0 });
                }
                const tracker = this.callerStats.get(0)!;
                const currLost = Number(c['packets-sent-lost'] ?? 0);
                const currSent = Number(c['packets-sent'] ?? 0);
                const deltaLost = currLost - tracker.prevLost;
                const deltaSent = currSent - tracker.prevSent;
                let packetLoss: string | number = '—';

                if (deltaSent > 0) {
                    const instantLoss = (deltaLost / (deltaSent + deltaLost)) * 100;
                    tracker.lossAvg = tracker.lossAvg * 0.7 + instantLoss * 0.3;
                    packetLoss = `${tracker.lossAvg.toFixed(2)}%`;
                } else if (tracker.prevSent > 0) {
                    packetLoss = `${tracker.lossAvg.toFixed(2)}%`;
                }

                tracker.prevLost = currLost;
                tracker.prevSent = currSent;

                this.dynamicStatusSections = [];
                this.setStatusData('stats', {
                    bitrate,
                    rtt,
                    packetLoss,
                    bytesSent,
                    callers: callerCount || '—',
                });
                if (isSending) {
                    this.setBadge('status', { icon: 'radio', text: 'Connected', color: '#10b981' });
                } else {
                    this.setBadge('status', {
                        icon: 'radio',
                        text: rawBytes > 0 ? 'Stalled' : 'Connecting',
                        color: '#f59e0b',
                    });
                }
                this.clearBadge('callers');
            }
        } catch {
            /* best-effort */
        }
    }

    private updateStatusData(): void {
        this.setStatusData('connection', {
            mode: (this.config.mode as string) ?? 'caller',
            host: (this.config.host as string) ?? '0.0.0.0',
            port: (this.config.port as number) ?? 9000,
            encrypted: (this.config.passphrase as string) ? 'Yes' : 'No',
        });
        if (this.config.passphrase) {
            this.setBadge('encrypted', { icon: 'lock', text: 'AES', color: '#8b5cf6' });
        }
    }
}
