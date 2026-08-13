import {
    GstPluginBase,
    buildBusSink,
    buildNetUdpSrc,
    buildBackpressureQueue,
    busTeeName,
    isMulticastAddr,
    formatBytes,
    bitrateBadge,
    NET_UDP_RCV_BUF,
    registerNetworkInterfaceDeviceProvider,
    type PipelineDescription,
    type EngineServices,
} from '@media-router/engine';
import {
    sniffEncapsulation,
    ifaceAddress,
    type Encapsulation,
} from './detectEncapsulation.js';

/**
 * MPEG-TS over IP input plugin.
 *
 * Receives MPEG-TS from the network over plain UDP or RTP/TS (multicast or
 * unicast) and rebroadcasts it on the local loopback bus for downstream
 * decoders/demuxers/players. Pure MPEG-TS passthrough — no decoding.
 *
 * Unlike SRT/RIST there is no connection handshake: a multicast group serves
 * unlimited receivers (IGMP join), a unicast listen takes whatever arrives on
 * the port. The network udpsrc binds a real NIC via `buildNetUdpSrc`, distinct
 * from the `lo`-bound loopback bus the output side feeds.
 */
/** Time budget for sniffing the first packet before falling back to raw. */
const DETECT_TIMEOUT_MS = 2000;

export class MpegTsIpInputModule extends GstPluginBase {
    /** Route-head playout offset (ADR-0005 decision 4) — consumed downstream,
     *  never by this pipeline, so it is live and never pends a restart. */
    protected liveUpdatableParams = ['playoutOffsetMs'];
    private statsTimer: ReturnType<typeof setInterval> | null = null;
    /** Encapsulation detected this run when the operator left it on `auto`. */
    private detectedEncap: Encapsulation | null = null;

    static registerServices(services: EngineServices): void {
        registerNetworkInterfaceDeviceProvider(services);
    }

    async onStart(): Promise<void> {
        // Assign a UDP port for local-bus multicast output (same as srt-input).
        if (this.services?.mediaRouter) {
            this.services.mediaRouter.assignBusChannel(this.services.instanceId);
        }

        // When encapsulation is `auto`, sniff the first packet so the module
        // just works regardless of whether the sender pushes raw UDP or RTP.
        // Done before super.onStart() builds the pipeline; the brief socket
        // bind is released before GStreamer takes the port.
        await this.detectEncapsulation();

        await super.onStart();

        // A stalled/down udpsrc is silent; reflect outages on the face immediately
        // rather than leaving a stale "flowing" badge across the restart backoff.
        this.childProcess?.on('stateChange', (data: { state: string }) => {
            if (data.state === 'stopped' || data.state === 'error') {
                this.setBadge('status', { icon: 'radio', text: 'Waiting', color: '#6b7280' });
                this.clearBadge('bitrate');
                // Probe state died with the python child — never show stale
                // geometry across a restart.
                this.setStatusData('video', { video: '—' });
            }
        });

        // Throughput tracking is established lazily by pollStats — registering
        // it here races the PLAYING transition (see the note in pollStats).
        this.statsTimer = setInterval(() => void this.pollStats(), 2000);
        this.updateStatusData();
    }

    async onStop(): Promise<void> {
        if (this.statsTimer) {
            clearInterval(this.statsTimer);
            this.statsTimer = null;
        }
        this.detectedEncap = null;
        await super.onStop();
    }

    /**
     * Effective encapsulation: an explicit `raw`/`rtp` setting wins; on `auto`
     * we use what `detectEncapsulation` sniffed, defaulting to `raw` if the
     * sniff hasn't run or timed out.
     */
    private effectiveEncap(config: Record<string, unknown>): Encapsulation {
        // An explicit raw/rtp wins; `auto` trusts the per-flow sniff. RTP (paired
        // with an RTP sender) lets the rtpjitterbuffer reorder out-of-order UDP
        // datagrams — the fix for reordering-induced macroblocking on this path.
        const configured = (config.encapsulation as string) ?? 'auto';
        if (configured === 'raw' || configured === 'rtp') return configured;
        return this.detectedEncap ?? 'raw';
    }

    /** Sniff raw-vs-RTP on the listen port when encapsulation is `auto`. */
    private async detectEncapsulation(): Promise<void> {
        this.detectedEncap = null;
        const configured = (this.config.encapsulation as string) ?? 'auto';
        if (configured !== 'auto') return;

        const port = (this.config.port as number) ?? 5000;
        const address = (this.config.address as string) ?? '0.0.0.0';
        const iface = (this.config.interface as string) ?? '';
        const multicast = isMulticastAddr(address);

        const result = await sniffEncapsulation({
            port,
            multicastGroup: multicast ? address : undefined,
            ifaceAddr: multicast && iface ? ifaceAddress(iface) : undefined,
            timeoutMs: DETECT_TIMEOUT_MS,
        });
        this.detectedEncap = result;
        this.log.info(
            { detected: result ?? 'none (defaulting to raw)' },
            'MPEG-TS IP input: auto-detected encapsulation',
        );
    }

    buildPipeline(config: Record<string, unknown>): PipelineDescription | null {
        const port = (config.port as number) ?? 5000;
        const address = (config.address as string) ?? '0.0.0.0';
        const iface = (config.interface as string) ?? '';
        const encapsulation = this.effectiveEncap(config);
        const jitterMs = (config.jitterMs as number) ?? 200;

        // Local-bus port for downstream modules.
        const endpoint = this.services?.mediaRouter?.getBusChannel(this.services.instanceId);
        const udpPort = endpoint?.port;
        if (!udpPort) {
            this.log.warn('No UDP port assigned — cannot output MPEG-TS');
            return null;
        }

        const multicast = isMulticastAddr(address);

        // RTP carries its own caps; raw UDP needs explicit MPEG-TS caps so
        // negotiation works before the first packet arrives. 5 s silence on the
        // network udpsrc posts a timeout the runner turns into a bus error so
        // the restart path triggers.
        const caps =
            encapsulation === 'rtp'
                ? 'application/x-rtp, media=(string)video, clock-rate=(int)90000, encoding-name=(string)MP2T'
                : 'video/mpegts, systemstream=(boolean)true, packetsize=(int)188';

        // 8 MB receive buffer on the network udpsrc (shared NET_UDP_RCV_BUF) —
        // burst headroom for keyframes, safely under net.core.rmem_max. (The
        // loopback udpsink keeps the helper default: requesting SO_SNDBUF at
        // wmem_max can make the sink fail to transmit — that broke the loopback
        // rebroadcast entirely.)
        const netSrc = buildNetUdpSrc({
            name: 'netsrc',
            port,
            multicastGroup: multicast ? address : undefined,
            iface: iface || undefined,
            caps,
            timeoutNs: 5_000_000_000,
            bufferSize: NET_UDP_RCV_BUF,
        });

        // Pure passthrough rebroadcast onto the local bus — mirror srt-input
        // (`srtsrc ! queue ! udpsink`), NO tsparse. tsparse aggregates TS
        // packets into large buffers (a keyframe at 720p/8Mbps yields 80 kB+),
        // which the loopback udpsink then can't send as a single datagram (UDP
        // max 65507 B) — it warns "packet larger than maximum size" and DROPS
        // them, so only the small inter-frames get through. The incoming
        // datagrams are already ~1316 B (7×188); leaving them un-aggregated
        // keeps every datagram well under the UDP limit. Downstream tsdemux
        // does the parsing — no need to re-frame/re-timestamp here.
        const depay = encapsulation === 'rtp' ? ['rtpjitterbuffer', 'rtpmp2tdepay'] : [];

        // Non-leaky (back-pressure, not drop): this is a pure loopback relay to
        // a `lo` multicast group, so the udpsink always drains and the queue
        // sits near-empty (≈0 added latency). A `leaky=2` queue here sheds whole
        // TS packets when a plain-UDP sender (mpegts-ip) bursts a keyframe —
        // which downstream surfaces as continuity errors / macroblocking even
        // though the wire (wired, same switch) lost nothing. Back-pressuring a
        // transient burst into the 8 MB udpsrc socket buffer keeps the relay
        // lossless on a clean link. (SRT input doesn't hit this because its
        // paced/recovered delivery never bursts the queue.)
        const pipeline = [
            netSrc,
            ...depay,
            buildBackpressureQueue(jitterMs),
            buildBusSink(udpPort),
        ].join(' ! ');

        // Video-info tap off the egress tee (report-only, `tsProbe` glue):
        // leaky queue is mandatory — a stalled appsink branch on a tee stalls
        // ALL branches, including the loopback relay this module exists for.
        const probeTap =
            ` ${busTeeName(udpPort)}. ! queue leaky=downstream max-size-buffers=64 ` +
            '! appsink name=tsprobe';

        return {
            pipeline: pipeline + probeTap,
            restartOnError: true,
            restartBackoffMs: { baseMs: 2000, maxMs: 10000 },
            tsProbe: { appsink: 'tsprobe' },
        };
    }

    /** `tsprobe:videoinfo` → the popup's Video line. Geometry fields are null
     *  until the SPS parses; `display` is pre-formatted ("1920×1080i50"). */
    protected onPluginEvent(channel: string, payload: unknown): void {
        if (channel !== 'tsprobe:videoinfo') return;
        const p = payload as { codec?: string; display?: string; scrambled?: boolean };
        this.setStatusData('video', {
            video: p.display
                ? `${p.display} (${p.codec})`
                : p.scrambled
                  ? `${p.codec ?? ''} (scrambled)`.trim()
                  : (p.codec ?? '—'),
        });
    }

    private async pollStats(): Promise<void> {
        if (!this.running) return;
        const tp = await this.getThroughput();
        const t = tp['netsrc'];
        if (!t) {
            // No tracker yet. Registering once in onStart races the PLAYING
            // transition — trackThroughput no-ops until the child pipeline is
            // live, so the pad probe never attaches and stats stay blank. A
            // pipeline restart likewise spawns a fresh Python child with an
            // empty tracker map. (Re)establish it here on the live poll loop;
            // the next tick reads the freshly-attached counter.
            await this.trackThroughput('netsrc', 'src');
            return;
        }
        const flowing = t.bitrate_mbps > 0;
        // Popup carries the exact bitrate/bytes. The face shows TWO badges when
        // flowing: an SRT-style status word ("Connected") plus a live bitrate
        // badge. UDP is connectionless, so "Connected" means packets are
        // arriving; "Stalled" (amber) means we received before but it dried up;
        // "Waiting" (grey) means nothing has arrived yet. The bitrate badge is
        // cleared when not flowing so a stale rate never lingers next to a
        // Stalled/Waiting status.
        this.setStatusData('stats', {
            bitrate: t.bitrate_mbps.toFixed(2),
            bytesReceived: formatBytes(t.total_bytes),
        });
        if (flowing) {
            this.setBadge('status', { icon: 'radio', text: 'Connected', color: '#10b981' });
            this.setBadge('bitrate', bitrateBadge(Math.round(t.bitrate_mbps * 1000)));
        } else {
            this.setBadge('status', {
                icon: 'radio',
                text: t.total_bytes > 0 ? 'Stalled' : 'Waiting',
                color: t.total_bytes > 0 ? '#f59e0b' : '#6b7280',
            });
            this.clearBadge('bitrate');
        }
    }

    private updateStatusData(): void {
        const address = (this.config.address as string) ?? '0.0.0.0';
        // Show the *effective* encapsulation, not the raw config: on `auto` the
        // operator needs to see what was actually sniffed off the wire (raw vs
        // RTP), annotated so it's clear the detection — not a manual setting —
        // chose it.
        const configured = (this.config.encapsulation as string) ?? 'auto';
        const effective = this.effectiveEncap(this.config);
        this.setStatusData('connection', {
            address,
            port: (this.config.port as number) ?? 5000,
            encapsulation: configured === 'auto' ? `${effective} (auto)` : effective,
            multicast: isMulticastAddr(address) ? 'Yes' : 'No',
        });
        this.setStatusData('video', { video: '—' });
    }
}
