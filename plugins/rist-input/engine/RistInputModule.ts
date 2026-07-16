import {
    GstPluginBase,
    buildUdpSink,
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
export class RistInputModule extends GstPluginBase {
    async onStart(): Promise<void> {
        // Assign the bus output channel before buildPipeline reads it back.
        // The port is the channel identity (busout_<port> tee under unixfd).
        if (this.services?.mediaRouter) {
            this.services.mediaRouter.assignUdpPort(this.services.instanceId);
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
        const endpoint = this.services?.mediaRouter?.getUdpEndpoint(this.services.instanceId);
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
            buildUdpSink({ host: endpoint.host, port: endpoint.port, name: 'usink' });

        const rist: RistRunnerConfig = {
            role: 'receiver',
            urls: this.links().map(buildRistUrl),
            profile: (this.config.profile as number) ?? 1,
            buffer: (this.config.buffer as number) ?? 1000,
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

        // Flow-level stats (aggregate across all peers)
        this.setStatusData('stats', {
            received: Number(s.received ?? 0),
            dropped: Number(s.dropped_late ?? 0),
            recovered: Number(s.recovered_total ?? 0),
            lost: Number(s.lost ?? 0),
            rtt: '—',
        });

        // Per-peer stats and dynamic sections
        const peers = flow.peers as
            | Array<{ id?: number; cname?: string; stats?: Record<string, unknown> }>
            | undefined;
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

            // Use first peer's RTT for the flow-level display
            const firstPeer = peers[0]?.stats;
            if (firstPeer) {
                this.setStatusData('stats', {
                    received: Number(s.received ?? 0),
                    dropped: Number(s.dropped_late ?? 0),
                    recovered: Number(s.recovered_total ?? 0),
                    lost: Number(s.lost ?? 0),
                    rtt:
                        typeof firstPeer.avg_rtt === 'number'
                            ? `${(firstPeer.avg_rtt as number).toFixed(2)}`
                            : String(firstPeer.rtt ?? '—'),
                });
            }
        }

        const quality = Number(s.quality ?? 0);
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
