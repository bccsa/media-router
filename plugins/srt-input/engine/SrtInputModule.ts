import { GstPluginBase, buildUdpSink, type PipelineDescription } from '@media-router/engine';

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * SRT Input plugin.
 *
 * Receives MPEG-TS from the network via SRT and rebroadcasts on local
 * UDP multicast for downstream decoders. Pure MPEG-TS passthrough —
 * no decoding or processing.
 *
 * Supports listener (accept connections), caller (connect to remote),
 * and rendezvous modes. Optional AES encryption via passphrase.
 */
export class SrtInputModule extends GstPluginBase {
    private statsTimer: ReturnType<typeof setInterval> | null = null;
    // Per-caller delta tracking for packet loss
    private callerStats = new Map<
        number,
        { prevLost: number; prevRecv: number; lossAvg: number }
    >();
    /** Previous bytes-received total — used to detect stalled connections in caller mode. */
    private lastRecvBytes = 0;

    async onStart(): Promise<void> {
        // SRT input gets a UDP port for local multicast output (same as encoders)
        if (this.services?.mediaRouter) {
            this.services.mediaRouter.assignEncoderPort(this.services.instanceId);
        }

        await super.onStart();

        // Reflect pipeline outages immediately. pollStats only runs while the
        // pipeline is playing, so without this hook a "Connected" badge from
        // the last good poll lingers across the 5s–10s restart-backoff window
        // (and srtsrc bus-errors briefly flip health=error to health=stopped,
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
                this.lastRecvBytes = 0;
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
        const mode = (config.mode as string) ?? 'listener';
        const latency = (config.latency as number) ?? 125;
        const streamId = (config.streamId as string) ?? '';
        const passphrase = (config.passphrase as string) ?? '';
        const pbKeyLen = (config.pbKeyLen as number) ?? 0;

        // Build SRT URI with parameters
        let uri = `srt://${host}:${port}`;
        const params: string[] = [`mode=${mode}`, `latency=${latency}`];
        if (streamId) params.push(`streamid=${streamId}`);
        if (passphrase) params.push(`passphrase=${passphrase}`);
        if (pbKeyLen > 0) params.push(`pbkeylen=${pbKeyLen}`);
        uri += '?' + params.join('&');

        // Get assigned UDP port for local multicast output
        const endpoint = this.services?.mediaRouter?.getEncoderEndpoint(this.services.instanceId);
        const udpPort = endpoint?.port;
        if (!udpPort) {
            this.log.warn('No UDP port assigned — cannot output MPEG-TS');
            return null;
        }

        // auto-reconnect=false: libsrt's built-in retry loop spawns a new SRT
        // socket (+ SndQ/RcvQ worker threads) every ~1s while the remote is
        // unreachable, which pegs CPU. Letting srtsrc emit the bus error
        // instead routes reconnects through restartBackoffMs. Cap is kept
        // tight (10s) — unlike a transient crash, an unreachable SRT peer
        // gains nothing from longer backoff: we don't know when it returns,
        // so retrying often is what feels snappy when it finally does.
        const pipeline = [
            `srtsrc name=src uri="${uri}" auto-reconnect=false`,
            'queue leaky=2 max-size-time=100000000 flush-on-eos=true',
            buildUdpSink({ host: '239.255.0.1', port: udpPort }),
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
            const stats = await this.getElementStats('src');
            if (!stats) return;

            const callers = stats['callers'] as Array<Record<string, unknown>> | undefined;
            const callerCount = callers?.length ?? 0;

            const callerFields = [
                { key: 'bitrate', label: 'Bitrate', unit: 'Mbps' },
                { key: 'rtt', label: 'RTT', unit: 'ms' },
                { key: 'packetLoss', label: 'Packet Loss' },
                { key: 'bytesReceived', label: 'Bytes Received' },
            ];

            const processCallerStats = (c: Record<string, unknown>, idx: number): void => {
                if (!this.callerStats.has(idx)) {
                    this.callerStats.set(idx, { prevLost: 0, prevRecv: 0, lossAvg: 0 });
                }
                const tracker = this.callerStats.get(idx)!;

                const rtt = (c['rtt-ms'] ?? '—') as string | number;
                const bitrate = (c['receive-rate-mbps'] ?? c['bandwidth-mbps'] ?? '—') as
                    | string
                    | number;
                const rawBytes = Number(c['bytes-received'] ?? 0);
                const bytesReceived = rawBytes > 0 ? formatBytes(rawBytes) : '—';

                const currLost = Number(c['packets-received-lost'] ?? 0);
                const currRecv = Number(c['packets-received'] ?? 0);
                const deltaLost = currLost - tracker.prevLost;
                const deltaRecv = currRecv - tracker.prevRecv;
                let packetLoss: string | number = '—';

                if (deltaRecv > 0) {
                    const instantLoss = (deltaLost / (deltaRecv + deltaLost)) * 100;
                    tracker.lossAvg = tracker.lossAvg * 0.7 + instantLoss * 0.3;
                    packetLoss = `${tracker.lossAvg.toFixed(2)}%`;
                } else if (tracker.prevRecv > 0) {
                    packetLoss = `${tracker.lossAvg.toFixed(2)}%`;
                }

                tracker.prevLost = currLost;
                tracker.prevRecv = currRecv;

                return this.setStatusData(`caller-${idx}`, {
                    bitrate,
                    rtt,
                    packetLoss,
                    bytesReceived,
                });
            };

            if (callers && callers.length > 0) {
                // Listener mode — per-caller dynamic sections
                const sections = callers.map((_, i) => ({
                    id: `caller-${i}`,
                    label: `Caller ${i + 1}`,
                    fields: callerFields,
                }));
                this.dynamicStatusSections = sections;
                for (let i = 0; i < callers.length; i++) processCallerStats(callers[i], i);
                // Clean up stale trackers
                for (const [idx] of this.callerStats) {
                    if (idx >= callers.length) this.callerStats.delete(idx);
                }
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
            } else {
                // Caller mode — check if actually connected by looking at recv bytes delta
                this.dynamicStatusSections = [];
                processCallerStats(stats, 0);
                const rawBytes = Number(
                    stats['bytes-received-total'] ?? stats['bytes-received'] ?? 0,
                );
                const prevBytes = this.lastRecvBytes ?? 0;
                const isConnected = rawBytes > 0 && rawBytes > prevBytes;
                this.lastRecvBytes = rawBytes;

                this.setStatusData('stats', {
                    ...(this.statusData['caller-0'] ?? {}),
                    bytesReceived: rawBytes > 0 ? formatBytes(rawBytes) : '—',
                    callers: callerCount || '—',
                });
                if (isConnected) {
                    this.setBadge('status', { icon: 'radio', text: 'Connected', color: '#10b981' });
                    this.clearBadge('callers');
                } else {
                    this.setBadge('status', {
                        icon: 'radio',
                        text: rawBytes > 0 ? 'Stalled' : 'Connecting',
                        color: '#f59e0b',
                    });
                    this.clearBadge('callers');
                }
            }
        } catch {
            /* best-effort */
        }
    }

    private updateStatusData(): void {
        this.setStatusData('connection', {
            mode: (this.config.mode as string) ?? 'listener',
            host: (this.config.host as string) ?? '0.0.0.0',
            port: (this.config.port as number) ?? 9000,
            encrypted: (this.config.passphrase as string) ? 'Yes' : 'No',
        });
        if (this.config.passphrase) {
            this.setBadge('encrypted', { icon: 'lock', text: 'AES', color: '#8b5cf6' });
        }
    }
}
