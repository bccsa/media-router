import {
    GstPluginBase,
    buildBusSink,
    SrtStatPoller,
    type PipelineDescription,
    type SrtStatPollerHost,
} from '@media-router/engine';

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
    /** Route-head playout offset (ADR-0005 decision 4) — consumed downstream,
     *  never by this pipeline, so it is live and never pends a restart. */
    protected liveUpdatableParams = ['playoutOffsetMs'];
    private statsTimer: ReturnType<typeof setInterval> | null = null;
    private statPoller: SrtStatPoller;

    constructor() {
        super();
        // The host bridges the poller's needs to GstPluginBase's protected
        // surface. `setSections` writes the mutable array directly because
        // `dynamicStatusSections` is exposed as a protected field.
        const host: SrtStatPollerHost = {
            isRunning: () => this.running,
            getElementStats: () => this.getElementStats('src'),
            setStatusData: (section, data) => this.setStatusData(section, data),
            setBadge: (id, badge) => this.setBadge(id, badge),
            clearBadge: (id) => this.clearBadge(id),
            setSections: (sections) => {
                this.dynamicStatusSections = sections;
            },
        };
        this.statPoller = new SrtStatPoller(host, 'receive');
    }

    async onStart(): Promise<void> {
        // SRT input gets a UDP port for local multicast output (same as encoders)
        if (this.services?.mediaRouter) {
            this.services.mediaRouter.assignBusChannel(this.services.instanceId);
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
        const endpoint = this.services?.mediaRouter?.getBusChannel(this.services.instanceId);
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
            buildBusSink(udpPort),
        ].join(' ! ');

        return {
            pipeline,
            restartOnError: true,
            restartBackoffMs: { baseMs: 5000, maxMs: 10000 },
        };
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
