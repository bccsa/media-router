import {
    GstPluginBase,
    INGEST_OFFSET_KEY,
    IngestTimingReporter,
    PID_TRIMS_KEY,
    SMOOTHING_COOLDOWN_KEY,
    applyIngestTimingLiveUpdate,
    buildBusSink,
    buildRestamp,
    isIngestTimingSection,
    restampBusReports,
    SrtStatPoller,
    type IngestTimingHost,
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
     *  never by this pipeline, so it is live and never pends a restart. O, the trims and the
     *  smoothing cooldown are the restamp's live properties (§5.5, B-95). */
    protected liveUpdatableParams = [
        'playoutOffsetMs',
        INGEST_OFFSET_KEY,
        PID_TRIMS_KEY,
        SMOOTHING_COOLDOWN_KEY,
    ];
    private statsTimer: ReturnType<typeof setInterval> | null = null;
    private statPoller: SrtStatPoller;
    /** The restamp's card: Clock badge and sections, one section per PID, part 10's warnings. */
    private readonly ingestTiming = new IngestTimingReporter(this.ingestTimingHost(), {
        mode: 'stc',
    });
    /** The reporter's warning text, so its clear never takes another warning down. */
    private clockWarning: string | null = null;

    constructor() {
        super();
        // The host bridges the poller's needs to GstPluginBase's protected
        // surface. `setSections` goes through `setDynamicSections` so a
        // departed caller's status row is dropped with its section.
        const host: SrtStatPollerHost = {
            isRunning: () => this.running,
            getElementStats: () => this.getElementStats('src'),
            setStatusData: (section, data) => this.setStatusData(section, data),
            setBadge: (id, badge) => this.setBadge(id, badge),
            clearBadge: (id) => this.clearBadge(id),
            setSections: (sections) => this.setCallerSections(sections),
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
                this.setCallerSections([]);
                this.statPoller.reset();
                // libsrt dropped the link: no PCR comes until a new pipeline reports (B-118).
                this.ingestTiming.down();
            }
        });

        this.statsTimer = setInterval(() => this.statPoller.poll(), 2000);
        this.ingestTiming.start();
        this.updateStatusData();
    }

    async onStop(): Promise<void> {
        if (this.statsTimer) {
            clearInterval(this.statsTimer);
            this.statsTimer = null;
        }
        this.statPoller.reset();
        this.ingestTiming.stop();
        await super.onStop();
    }

    async onLiveConfigUpdate(changes: Record<string, unknown>): Promise<void> {
        await super.onLiveConfigUpdate(changes);
        await applyIngestTimingLiveUpdate(
            { setElementProperty: (e, p, v) => this.setElementProperty(e, p, v) },
            changes,
        );
    }

    protected onPluginEvent(channel: string, payload: unknown): void {
        this.ingestTiming.onEvent(channel, payload);
    }

    /** Every PLAYING sets health ok: put a standing clock warning back. */
    protected onPipelinePlaying(): void {
        this.ingestTiming.reassert();
    }

    buildPipeline(config: Record<string, unknown>): PipelineDescription | null {
        const host = (config.host as string) ?? '0.0.0.0';
        const port = (config.port as number) ?? 9000;
        const mode = (config.mode as string) ?? 'listener';
        const latency = (config.latency as number) ?? 125;
        const streamId = (config.streamId as string) ?? '';
        const passphrase = (config.passphrase as string) ?? '';
        const pbKeyLen = (config.pbKeyLen as number) ?? 0;

        // Build the SRT URI. Free text is percent-encoded (B-112): srtsrc decodes each value,
        // which a `#`, `&`, `"`, `\` or `%` typed into it would otherwise cut, change or break.
        let uri = `srt://${host}:${port}`;
        const params: string[] = [`mode=${mode}`, `latency=${latency}`];
        if (streamId) params.push(`streamid=${encodeURIComponent(streamId)}`);
        if (passphrase) params.push(`passphrase=${encodeURIComponent(passphrase)}`);
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

        // keep-listening=true: a listener srtsrc otherwise EOSes (not errors)
        // when its caller drops; with no bus edge attached that EOS is lost and
        // the runner wedges with the port unbound.
        const keepListening = mode === 'listener' ? ' keep-listening=true' : '';
        // The restamp reads arrival itself, so it sits before the queue (OQ-19): srtsrc's
        // buffer PTS is the sender's send time in gst-plugins-bad 1.28, not receipt.
        const restamp = buildRestamp({
            mode: 'stc',
            offsetMs: config[INGEST_OFFSET_KEY],
            pidTrimsMs: config[PID_TRIMS_KEY],
            smoothingCooldownMin: config[SMOOTHING_COOLDOWN_KEY],
        });
        const pipeline = [
            `srtsrc name=src uri="${uri}" auto-reconnect=false${keepListening}`,
            restamp,
            'queue leaky=2 max-size-time=100000000 flush-on-eos=true',
            buildBusSink(udpPort),
        ].join(' ! ');

        return {
            pipeline,
            restartOnError: true,
            restartBackoffMs: { baseMs: 5000, maxMs: 10000 },
            busReports: restampBusReports(),
        };
    }

    /** The poller's caller sections; the restamp's and the base's stay (one list in the base). */
    private setCallerSections(sections: typeof this.dynamicStatusSections): void {
        const others = this.dynamicStatusSections.filter((s) => !s.id.startsWith('caller-'));
        this.setDynamicSections([...sections, ...others]);
    }

    /** A return to ok shows a standing clock warning again: another warning may have hidden it. */
    setHealth(...args: Parameters<GstPluginBase['setHealth']>): void {
        super.setHealth(...args);
        if (args[0] === 'ok') this.ingestTiming.reassert();
    }

    private ingestTimingHost(): IngestTimingHost {
        return {
            // The base keeps one list of dynamic sections: anyone else's stay.
            setDynamicSections: (sections) => {
                const others = this.dynamicStatusSections.filter(
                    (s) => !isIngestTimingSection(s.id),
                );
                this.setDynamicSections([...others, ...sections]);
            },
            setStatusData: (id, data) => this.setStatusData(id, data),
            setBadge: (id, badge) => this.setBadge(id, badge),
            clearBadge: (id) => this.clearBadge(id),
            setFieldOptions: (key, options) => this.setFieldOptions(key, options),
            // Over ok or another warning, never over a fault or a stop: PLAYING re-asserts it.
            warn: (text) => {
                this.clockWarning = text;
                if (this.health === 'ok' || this.health === 'warning') {
                    this.setHealth('warning', text);
                }
            },
            clearWarning: () => {
                if (this.health === 'warning' && this.error === this.clockWarning) {
                    this.setHealth('ok');
                }
                this.clockWarning = null;
            },
            log: (level, obj, msg) => this.log[level](obj, msg),
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
