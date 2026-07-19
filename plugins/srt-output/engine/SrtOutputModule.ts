import {
    GstPluginBase,
    buildBackpressureQueue,
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
        const packetsPerDatagram = (config.packetsPerDatagram as number) ?? 0;
        const outputPacing = (config.outputPacing as boolean) ?? false;

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
        // Pure byte passthrough by default (packetsPerDatagram=0): relay the bus
        // datagrams to SRT as-is, no TS parsing. Re-parsing/re-chunking a lossy
        // live stream can scramble the picture (tsparse re-timing — see the
        // mpegts-demuxer notes), and for a same-size passthrough it is needless.
        // Only insert tsparse when a specific wire datagram size is forced (>= 1).
        //
        // outputPacing: re-time from the stream's own PCR (tsparse
        // set-timestamps) and let srtsink honour those timestamps (sync=true) —
        // this converts hold-and-burst delivery (an upstream mux aggregator can
        // emit ~100-250 ms clumps at line rate) back to wire cadence, for
        // receivers whose jitter buffer can't ride out the bursts. Pacing needs
        // BOTH set-timestamps and an alignment, and only works in a static
        // pipeline like this one (inert on runtime-added branches). It holds up
        // to ~one burst interval in the relay queue, so the queue cap is raised
        // to keep back-pressure off the bus edge. Off by default: sync=false
        // passthrough stays the safe choice for lossy/PCR-degraded sources.
        const align = packetsPerDatagram >= 1 ? packetsPerDatagram : 7;
        const repack = outputPacing
            ? [`tsparse alignment=${align} set-timestamps=true`]
            : packetsPerDatagram >= 1
              ? [`tsparse alignment=${packetsPerDatagram} set-timestamps=false`]
              : [];
        const pipeline = [
            buildUdpSrc({
                host: udpSource.host,
                port: udpSource.port,
                socketPath: udpSource.socketPath,
            }),
            // NON-leaky: a leaky shed on muxed TS is mid-stream corruption at the wire.
            buildBackpressureQueue(outputPacing ? 500 : 200),
            ...repack,
            `srtsink name=sink uri="${uri}" sync=${outputPacing} ` +
                'wait-for-connection=false auto-reconnect=false',
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
