import {
    GstPluginBase,
    buildBusSink,
    type PipelineDescription,
    type RistRunnerConfig,
} from '@media-router/engine';

interface RistLink {
    mode: 'listener' | 'caller';
    address: string;
    port: number;
    weight: number;
    cname: string;
}

/** `name=` of the appsrc the runner's librist receiver pushes payloads into. */
const RIST_APPSRC = 'ristsrc';

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
/**
 * Link-health hysteresis on librist's quality metric (100 = no loss). RIST
 * recovers lost packets via retransmission, so a badly degraded link can carry
 * a perfect stream — invisible unless surfaced here. Field case, 2026-08-02:
 * production-hours loss storms of 10–20 % (all recovered, `lost=0`) were the
 * prime suspect behind intermittent video delivery dips, yet every ad-hoc
 * link check came back clean because only unrecovered loss is observable.
 * Warn after WARN_STREAK consecutive low-quality stats windows; clear only
 * after CLEAR_STREAK clean ones so a flapping link doesn't flap the health.
 */
const QUALITY_WARN = 85;
const QUALITY_CLEAR = 95;
const WARN_STREAK = 3;
const CLEAR_STREAK = 5;

export class RistInputModule extends GstPluginBase {
    /** Route-head playout offset (ADR-0005 decision 4) — consumed downstream,
     *  never by this pipeline, so it is live and never pends a restart. */
    protected liveUpdatableParams = ['playoutOffsetMs'];
    private linkWarnActive = false;
    private lowStreak = 0;
    private okStreak = 0;

    async onStart(): Promise<void> {
        // A rebuilt receiver re-measures from scratch — stale hysteresis must
        // not suppress or fake a link warning.
        this.linkWarnActive = false;
        this.lowStreak = 0;
        this.okStreak = 0;
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
    }

    buildPipeline(_config: Record<string, unknown>): PipelineDescription | null {
        const endpoint = this.services?.mediaRouter?.getBusChannel(this.services.instanceId);
        if (!endpoint) {
            this.log.warn('No UDP port assigned — cannot output MPEG-TS');
            return null;
        }

        // appsrc: live (PLAYING without preroll — required by the runner's
        // playing watchdog), timestamped on arrival like udpsrc was, and
        // bounded+leaky so a downstream stall sheds here instead of growing
        // memory — librist's own recovery buffer is the real jitter absorber.
        const pipeline =
            `appsrc name=${RIST_APPSRC} is-live=true do-timestamp=true format=time ` +
            'caps="video/mpegts, systemstream=(boolean)true, packetsize=(int)188" ' +
            'leaky-type=downstream max-bytes=4194304 ! ' +
            buildBusSink(endpoint.port);

        const rist: RistRunnerConfig = {
            role: 'receiver',
            urls: this.links().map(buildRistUrl),
            profile: (this.config.profile as number) ?? 1,
            buffer: (this.config.buffer as number) ?? 1000,
            sessionTimeout: (this.config.sessionTimeout as number) || undefined,
            secret: (this.config.secret as string) || undefined,
            encType: (this.config.encryptionType as number) || undefined,
            statsInterval: (this.config.statsInterval as number) ?? 1000,
            appElement: RIST_APPSRC,
        };

        return { pipeline, restartOnError: true, rist };
    }

    protected onPluginEvent(channel: string, payload: unknown): void {
        if (channel === 'rist:stats') {
            this.applyStats(payload as Record<string, any>);
        }
    }

    private links(): RistLink[] {
        return (
            (this.config.links as RistLink[]) ?? [
                { mode: 'listener', address: '0.0.0.0', port: 5004, weight: 50, cname: 'link1' },
            ]
        );
    }

    /** Render a librist receiver-stats payload (same JSON the CLI printed). */
    private applyStats(json: Record<string, any>): void {
        const flow = json?.['receiver-stats']?.flowinstant;
        if (!flow?.stats) return;

        const s = flow.stats;

        // Recovered-loss rate this stats window: what fraction of the wire
        // went missing before retransmission repaired it. `lost` only counts
        // UNrecovered packets, so this is the metric that exposes a degraded
        // link that still delivers a perfect stream.
        const missing = Number(s.missing ?? 0);
        const received = Number(s.received ?? 0);
        const lossPct = received + missing > 0 ? (100 * missing) / (received + missing) : 0;

        const peers = flow.peers as
            | Array<{ id?: number; cname?: string; stats?: Record<string, unknown> }>
            | undefined;
        const firstPeer = peers?.[0]?.stats;
        const rtt =
            typeof firstPeer?.avg_rtt === 'number'
                ? (firstPeer.avg_rtt as number).toFixed(2)
                : String(firstPeer?.rtt ?? '—');

        // Flow-level stats (aggregate across all peers)
        this.setStatusData('stats', {
            received,
            dropped: Number(s.dropped_late ?? 0),
            recovered: Number(s.recovered_total ?? 0),
            loss: lossPct.toFixed(1),
            lost: Number(s.lost ?? 0),
            rtt,
        });

        // Per-peer stats and dynamic sections
        if (peers && peers.length > 0) {
            const peerFields = [
                { key: 'quality', label: 'Quality', unit: '%' },
                { key: 'received', label: 'Received' },
                { key: 'dropped', label: 'Dropped' },
                { key: 'recovered', label: 'Recovered' },
                { key: 'lost', label: 'Permanently Lost' },
                { key: 'rtt', label: 'RTT', unit: 'ms' },
            ];

            for (const peer of peers) {
                const p = peer.stats;
                if (!p) continue;

                const peerId = peer.id ?? 0;
                const cname = peer.cname || `Link ${peerId}`;
                const sectionId = `peer-${peerId}`;

                this.setStatusData(sectionId, {
                    quality: typeof p.quality === 'number' ? p.quality : 0,
                    received: Number(p.received ?? 0),
                    dropped: Number(p.dropped_late ?? 0),
                    recovered: Number(p.recovered_total ?? 0),
                    lost: Number(p.lost ?? 0),
                    rtt:
                        typeof p.avg_rtt === 'number'
                            ? `${(p.avg_rtt as number).toFixed(2)}`
                            : String(p.rtt ?? '—'),
                });

                const existing = this.dynamicStatusSections.find((sec) => sec.id === sectionId);
                if (!existing) {
                    this.dynamicStatusSections = [
                        ...this.dynamicStatusSections,
                        { id: sectionId, label: cname, fields: peerFields },
                    ];
                }
            }
        }

        const quality = Number(s.quality ?? 0);
        this.applyLinkHealth(quality, lossPct, rtt);
        this.setBadge('quality', {
            icon: 'signal',
            text: `${quality}%`,
            color: quality >= 90 ? '#10b981' : quality >= 50 ? '#f59e0b' : '#ef4444',
        });

        // Connection badge — show peer count
        const peerCount = peers?.length ?? 0;
        this.setBadge('connections', {
            icon: 'link',
            text: `${peerCount}`,
            color: peerCount > 0 ? '#10b981' : '#6b7280',
        });
    }

    /** See the hysteresis constants above for why this exists. */
    private applyLinkHealth(quality: number, lossPct: number, rtt: string): void {
        if (quality < QUALITY_WARN) {
            this.lowStreak++;
            this.okStreak = 0;
        } else if (quality >= QUALITY_CLEAR) {
            this.okStreak++;
            this.lowStreak = 0;
        } else {
            // In-between band: neither degrades further nor proves recovery.
            this.lowStreak = 0;
            this.okStreak = 0;
        }
        if (this.lowStreak >= WARN_STREAK) {
            this.linkWarnActive = true;
            this.setHealth(
                'warning',
                `RIST link degraded — recovering ${lossPct.toFixed(0)}% packet loss ` +
                    `(RTT ${rtt} ms); stream still intact`,
            );
        } else if (this.okStreak >= CLEAR_STREAK && this.linkWarnActive) {
            // Only clear health WE degraded — never stomp a warning another
            // path owns.
            if (this.health === 'warning') this.setHealth('ok');
            this.linkWarnActive = false;
        }
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
