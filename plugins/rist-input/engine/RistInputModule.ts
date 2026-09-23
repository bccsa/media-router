import {
    GstPluginBase,
    buildBusSink,
    formatBitrate,
    quoteGstString,
    type PipelineDescription,
} from '@media-router/engine';
import { RistFlowTracker, peerRtt } from './ristFlowTracker.js';
import { RistLinkHealth } from './ristLinkHealth.js';

interface RistLink {
    mode: 'listener' | 'caller';
    address: string;
    port: number;
    weight: number;
    cname: string;
}

/** `name=` of the native `mrristsrc` element (rist-core/native/mrrist). */
const RIST_SRC = 'ristsrc';
/** Bus-message structure the element posts librist's stats JSON under. */
const RIST_STATS_STRUCTURE = 'mrrist-stats';
/** {id, cname}: the remote's SDES name per peer id, lifted from librist's log by
 *  the element — the receiver stats JSON names peers by id only. */
const RIST_PEER_STRUCTURE = 'mrrist-peer';
/** Names outlive their peer briefly (they arrive before the first stats window). */
const PEER_NAME_CAP = 64;

/**
 * RIST Input plugin.
 *
 * Receives MPEG-TS from the network via RIST — librist driven in-process by
 * the pipeline runner (ctypes binding), pushing payloads straight into this
 * module's appsrc. That makes the module a normal gst bus producer (tee
 * fan-out under unixfd, udpsink on the legacy udp bus) with no intermediate
 * UDP relay hop, unlike the old ristreceiver CLI which could only reach the
 * bus through its own loopback UDP socket.
 *
 * librist (not the gst ristsrc element, which is Simple-Profile/RTP only) is
 * kept for full feature support: per-link weight, cname, main/advanced
 * profiles, encryption.
 */
/** How often the card re-checks for flows that went silent (librist stops
 *  reporting a flow the moment it has no queued data — no farewell). */
const SWEEP_MS = 2000;

/** Per-peer rows: the receiver JSON carries no cname and no per-peer quality
 *  or loss — only these counters — so the label is librist's peer id. */
const PEER_FIELDS = [
    { key: 'bitrate', label: 'Bitrate' },
    { key: 'received', label: 'Packets Received' },
    { key: 'rtcpIn', label: 'RTCP Received' },
    { key: 'rtcpOut', label: 'RTCP Sent' },
    { key: 'rtt', label: 'RTT', unit: 'ms' },
];

export class RistInputModule extends GstPluginBase {
    /** Route-head playout offset (ADR-0005 decision 4) — consumed downstream,
     *  never by this pipeline, so it is live and never pends a restart. */
    protected liveUpdatableParams = ['playoutOffsetMs'];
    private linkHealth = new RistLinkHealth();
    private flows = new RistFlowTracker();
    private peerNames = new Map<number, string>();
    private sweepTimer: ReturnType<typeof setInterval> | null = null;

    async onStart(): Promise<void> {
        this.linkHealth.reset();
        this.flows.reset();
        this.peerNames.clear();
        // Assign the bus output channel before buildPipeline reads it back.
        // The port is the channel identity (busout_<port> tee under unixfd).
        if (this.services?.mediaRouter) {
            this.services.mediaRouter.assignBusChannel(this.services.instanceId);
        }

        await super.onStart();

        const links = this.links();
        const profile = (this.config.profile as number) ?? 1;
        this.setStatusData('connection', {
            profile: ['simple', 'main', 'advanced'][profile] ?? 'main',
            linkCount: links.length,
            encrypted: (this.config.secret as string) ? 'Yes' : 'No',
        });
        // librist emits no receiver stats until a flow carries data, so a
        // never-connected input would otherwise show no badge at all.
        this.renderPeers();
        this.sweepTimer = setInterval(() => {
            if (this.flows.sweep(Date.now(), this.staleMs())) this.renderPeers();
        }, SWEEP_MS);
    }

    async onStop(): Promise<void> {
        if (this.sweepTimer) {
            clearInterval(this.sweepTimer);
            this.sweepTimer = null;
        }
        await super.onStop();
    }

    buildPipeline(_config: Record<string, unknown>): PipelineDescription | null {
        const endpoint = this.services?.mediaRouter?.getBusChannel(this.services.instanceId);
        if (!endpoint) {
            this.log.warn('No UDP port assigned — cannot output MPEG-TS');
            return null;
        }

        // mrristsrc: live, arrival-timestamped (what the appsrc it replaced was
        // configured to). The leaky queue keeps the old contract that a
        // downstream stall sheds HERE instead of growing memory — librist's own
        // recovery buffer is the real jitter absorber.
        const secret = (this.config.secret as string) || '';
        const encType = (this.config.encryptionType as number) || 0;
        const sessionTimeout = (this.config.sessionTimeout as number) || 0;
        const props = [
            `urls=${quoteGstString(this.links().map(buildRistUrl).join(' '))}`,
            `profile=${(this.config.profile as number) ?? 1}`,
            `buffer=${(this.config.buffer as number) ?? 1000}`,
            // librist deletes a flow after this long with no data (default
            // 2000 ms); on links with brief blackouts ~10000 ms keeps the flow
            // alive through the gap instead of a delete/reconnect churn.
            ...(sessionTimeout ? [`session-timeout=${sessionTimeout}`] : []),
            ...(secret ? [`secret=${quoteGstString(secret)}`] : []),
            ...(encType ? [`aes-type=${encType}`] : []),
            `stats-interval=${this.statsIntervalMs()}`,
        ];
        const pipeline =
            `mrristsrc name=${RIST_SRC} ${props.join(' ')} ! ` +
            'queue leaky=downstream max-size-bytes=4194304 max-size-buffers=0 max-size-time=0 ! ' +
            buildBusSink(endpoint.port);

        return {
            pipeline,
            restartOnError: true,
            busReports: [
                { element: RIST_SRC, structure: RIST_STATS_STRUCTURE },
                { element: RIST_SRC, structure: RIST_PEER_STRUCTURE },
            ],
        };
    }

    protected onPluginEvent(channel: string, payload: unknown): void {
        if (channel === 'rist:stats') {
            // Legacy channel: the runner's python librist binding (still the
            // fallback when a pipeline carries a `rist` runner config).
            this.applyStats(payload as Record<string, any>);
        } else if (channel === `${RIST_STATS_STRUCTURE}:${RIST_SRC}`) {
            const parsed = parseStatsMessage(payload);
            if (parsed) this.applyStats(parsed);
        } else if (channel === `${RIST_PEER_STRUCTURE}:${RIST_SRC}`) {
            this.applyPeerName(payload as { id?: unknown; cname?: unknown } | null);
        }
    }

    private links(): RistLink[] {
        return (
            (this.config.links as RistLink[]) ?? [
                { mode: 'listener', address: '0.0.0.0', port: 5004, weight: 50, cname: 'link1' },
            ]
        );
    }

    private statsIntervalMs(): number {
        return (this.config.statsInterval as number) ?? 1000;
    }

    /** A flow that missed three stats windows is gone (min 3 s). */
    private staleMs(): number {
        return Math.max(3000, 3 * this.statsIntervalMs());
    }

    /** Remote link name for a peer id; re-labels the row if it is already shown. */
    private applyPeerName(msg: { id?: unknown; cname?: unknown } | null): void {
        const id = Number(msg?.id);
        const cname = typeof msg?.cname === 'string' ? msg.cname.trim() : '';
        if (!Number.isFinite(id) || !cname) return;
        this.peerNames.set(id, cname);
        for (const key of this.peerNames.keys()) {
            if (this.peerNames.size <= PEER_NAME_CAP) break;
            this.peerNames.delete(key);
        }
        if (this.flows.livePeers().some((p) => (p.id ?? 0) === id)) this.renderPeers();
    }

    /** One librist receiver-stats payload (same JSON the CLI prints): one flow. */
    private applyStats(json: Record<string, any>): void {
        const flow = json?.['receiver-stats']?.flowinstant;
        if (!flow?.stats) return;
        const now = Date.now();
        this.flows.observe(flow, now);
        this.flows.sweep(now, this.staleMs());
        this.renderFlowStats();
        this.renderPeers();
    }

    /** Live Stats section, quality badge and link health — across all fresh flows. */
    private renderFlowStats(): void {
        const c = this.flows.counters();
        // Recovered-loss rate this stats window: what fraction of the wire
        // went missing before retransmission repaired it. `lost` only counts
        // UNrecovered packets, so this is the metric that exposes a degraded
        // link that still delivers a perfect stream.
        const lossPct =
            c.received + c.missing > 0 ? (100 * c.missing) / (c.received + c.missing) : 0;
        const rtt = peerRtt(this.flows.livePeers()[0]);

        this.setStatusData('stats', {
            quality: c.quality,
            received: c.received,
            dropped: c.dropped,
            recovered: c.recovered,
            loss: lossPct.toFixed(1),
            lost: c.lost,
            rtt,
        });
        this.linkHealth.update(c.quality, lossPct, rtt, {
            warn: (msg) => this.setHealth('warning', msg),
            clearOwnWarning: () => {
                if (this.health === 'warning') this.setHealth('ok');
            },
        });
        this.setBadge('quality', {
            icon: 'signal',
            text: `${c.quality}%`,
            color: c.quality >= 90 ? '#10b981' : c.quality >= 50 ? '#f59e0b' : '#ef4444',
        });
    }

    /** Per-peer sections reconciled to the live set, and the connections badge. */
    private renderPeers(): void {
        const live = this.flows.livePeers();
        const sections = live.map((peer) => ({
            id: `peer-${peer.id ?? 0}`,
            label: this.peerNames.get(peer.id ?? 0) ?? `Peer ${peer.id ?? 0}`,
            fields: PEER_FIELDS,
        }));
        // A reconnected peer gets a fresh librist id, so anything not live
        // this window is a ghost (25 piled up on one single-link input).
        this.setDynamicSections(sections);
        for (const peer of live) {
            const p = peer.stats ?? {};
            this.setStatusData(`peer-${peer.id ?? 0}`, {
                // librist reports bits/s; the shared formatter takes kbps and
                // picks the unit itself.
                bitrate: typeof p.bitrate === 'number' ? formatBitrate(p.bitrate / 1000) : '—',
                received: Number(p.received_data ?? 0),
                rtcpIn: Number(p.received_rtcp ?? 0),
                rtcpOut: Number(p.sent_rtcp ?? 0),
                rtt: peerRtt(peer),
            });
        }

        // Live peers over configured links: a link that never connected (or a
        // listener with more senders than links) shows on the card as amber.
        const peerCount = live.length;
        const linkCount = this.links().length;
        this.setBadge('connections', {
            icon: 'link',
            text: `${peerCount}/${linkCount}`,
            color: peerCount === 0 ? '#6b7280' : peerCount === linkCount ? '#10b981' : '#f59e0b',
        });
    }
}

/** `mrrist-stats` bus message → the stats object librist produced (or null). */
function parseStatsMessage(payload: unknown): Record<string, any> | null {
    const json = (payload as { json?: unknown } | null)?.json;
    if (typeof json !== 'string') return null;
    try {
        return JSON.parse(json) as Record<string, any>;
    } catch {
        return null;
    }
}

/** rist:// URL for one link — per-link params (weight, cname) stay in the URL. */
function buildRistUrl(link: RistLink): string {
    const params: string[] = [];
    if (link.weight !== undefined) params.push(`weight=${link.weight}`);
    if (link.cname) params.push(`cname=${link.cname}`);
    // RIST URL: rist://@host:port for listener, rist://host:port for caller
    const addr =
        link.mode === 'listener' ? `@${link.address || '0.0.0.0'}` : link.address || 'localhost';
    return `rist://${addr}:${link.port}${params.length ? '?' + params.join('&') : ''}`;
}
