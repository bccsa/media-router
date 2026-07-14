import {
    GstPluginBase,
    buildLeakyQueue,
    buildUdpSrc,
    SrtStatPoller,
    type PipelineDescription,
    type SrtStatPollerHost,
} from '@media-router/engine';

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
    private statPoller: SrtStatPoller;

    constructor() {
        super();
        const host: SrtStatPollerHost = {
            isRunning: () => this.running,
            getElementStats: () => this.getElementStats('sink'),
            setStatusData: (section, data) => this.setStatusData(section, data),
            setBadge: (id, badge) => this.setBadge(id, badge),
            clearBadge: (id) => this.clearBadge(id),
            setSections: (sections) => {
                this.dynamicStatusSections = sections;
            },
        };
        this.statPoller = new SrtStatPoller(host, 'send');
    }

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
                this.statPoller.reset();
            }
        });

        this.statsTimer = setInterval(() => this.statPoller.poll(), 2000);
        this.updateStatusData();
    }

    async onStop(): Promise<void> {
        if (this.statsTimer) {
            clearInterval(this.statsTimer);
            this.statsTimer = null;
        }
        this.statPoller.reset();
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
        const packetsPerDatagram = (config.packetsPerDatagram as number) ?? 7;

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
        // Re-pack the 188-byte internal TS into wire-sized datagrams for SRT.
        // Default 7 = 1316 B (the standard SRT payload); tsparse alignment=N groups
        // N packets per buffer and set-timestamps=false preserves the source PCR
        // (spike-verified). The internal bus is always 188 B — packing is egress-only.
        const pipeline = [
            buildUdpSrc({ host: udpSource.host, port: udpSource.port }),
            buildLeakyQueue(100),
            `tsparse alignment=${packetsPerDatagram} set-timestamps=false`,
            `srtsink name=sink uri="${uri}" sync=false wait-for-connection=false auto-reconnect=false`,
        ].join(' ! ');

        return {
            pipeline,
            restartOnError: true,
            restartBackoffMs: { baseMs: 5000, maxMs: 10000 },
        };
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
