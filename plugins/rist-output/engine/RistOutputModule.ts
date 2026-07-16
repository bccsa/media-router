import {
    GstPluginBase,
    buildUdpSrc,
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

/** `name=` of the appsink the runner drains into its librist sender. */
const RIST_APPSINK = 'ristsink';

/**
 * RIST Output plugin.
 *
 * Reads local MPEG-TS off the inter-module bus as a normal gst consumer
 * (per-edge unixfdsrc under the fan-out bus, udpsrc on the legacy udp bus)
 * and sends it over the network via RIST — librist driven in-process by the
 * pipeline runner (ctypes binding), fed from this module's appsink. No
 * intermediate UDP relay hop, unlike the old ristsender CLI which could only
 * read the bus through its own loopback UDP socket.
 *
 * librist (not the gst ristsink element, which is Simple-Profile/RTP only) is
 * kept for full feature support: per-link weight, cname, main/advanced
 * profiles, encryption, NPD.
 */
export class RistOutputModule extends GstPluginBase {
    private peerLastSeen = new Map<number, number>(); // peerId → timestamp
    private peerCleanupTimer: ReturnType<typeof setInterval> | null = null;

    async onStart(): Promise<void> {
        await super.onStart();

        const links = this.links();
        const profile = (this.config.profile as number) ?? 1;
        this.setStatusData('connection', {
            profile: ['simple', 'main', 'advanced'][profile] ?? 'main',
            linkCount: links.length,
            encrypted: (this.config.secret as string) ? 'Yes' : 'No',
        });

        // Periodic cleanup of stale peers (detect disconnects even when no new stats arrive)
        this.peerCleanupTimer = setInterval(() => this.cleanupStalePeers(), 2000);
    }

    async onStop(): Promise<void> {
        if (this.peerCleanupTimer) {
            clearInterval(this.peerCleanupTimer);
            this.peerCleanupTimer = null;
        }
        this.peerLastSeen.clear();
        await super.onStop();
    }

    buildPipeline(_config: Record<string, unknown>): PipelineDescription | null {
        // Bus source from the connected producer (per-consumer edge socket
        // under unixfd — same resolution as every other bus consumer).
        const instanceId = this.services?.instanceId ?? '';
        const udpSource = this.services?.mediaRouter?.getModuleUdpSource(instanceId);
        if (!udpSource) {
            this.log.info('No MPEG-TS source connected — idle');
            return null;
        }

        // appsink properties (bounded/dropping/unsynced) are applied by the
        // runner when it wires librist — the string only names the element.
        const pipeline = [
            buildUdpSrc({
                host: udpSource.host,
                port: udpSource.port,
                socketPath: udpSource.socketPath,
            }),
            `appsink name=${RIST_APPSINK}`,
        ].join(' ! ');

        const rist: RistRunnerConfig = {
            role: 'sender',
            urls: this.links().map(buildRistUrl),
            profile: (this.config.profile as number) ?? 1,
            buffer: (this.config.buffer as number) ?? 1000,
            secret: (this.config.secret as string) || undefined,
            encType: (this.config.encryptionType as number) || undefined,
            npd: (this.config.nullPacketDeletion as boolean) ?? false,
            statsInterval: (this.config.statsInterval as number) ?? 1000,
            appElement: RIST_APPSINK,
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
                { mode: 'caller', address: 'localhost', port: 5004, weight: 50, cname: 'link1' },
            ]
        );
    }

    private cleanupStalePeers(): void {
        const now = Date.now();
        let changed = false;
        for (const [id, ts] of this.peerLastSeen) {
            if (now - ts > 3000) {
                this.peerLastSeen.delete(id);
                this.dynamicStatusSections = this.dynamicStatusSections.filter(
                    (sec) => sec.id !== `peer-${id}`,
                );
                changed = true;
            }
        }
        if (changed) {
            const peerCount = this.peerLastSeen.size;
            this.setBadge('connections', {
                icon: 'link',
                text: `${peerCount}`,
                color: peerCount > 0 ? '#10b981' : '#6b7280',
            });
            if (peerCount === 0) {
                this.clearBadge('quality');
            }
        }
    }

    /** Render a librist sender-stats payload (same JSON the CLI printed —
     *  one object per peer per stats interval). */
    private applyStats(json: Record<string, any>): void {
        const peer = json?.['sender-stats']?.peer;
        if (!peer?.stats) return;

        const s = peer.stats;
        const peerId = peer.id ?? 0;
        const cname = peer.cname || `Link ${peerId}`;
        const sectionId = `peer-${peerId}`;

        // Per-link stats
        this.setStatusData(sectionId, {
            quality: typeof s.quality === 'number' ? s.quality : 0,
            sent: Number(s.sent ?? 0),
            retransmitted: Number(s.retransmitted ?? 0),
            bandwidth: typeof s.bandwidth === 'number' ? `${s.bandwidth} kbps` : '—',
            rtt: typeof s.avg_rtt === 'number' ? `${s.avg_rtt.toFixed(2)}` : String(s.rtt ?? '—'),
        });

        // Dynamic section per peer
        const peerFields = [
            { key: 'quality', label: 'Quality', unit: '%' },
            { key: 'sent', label: 'Packets Sent' },
            { key: 'retransmitted', label: 'Retransmitted' },
            { key: 'bandwidth', label: 'Bandwidth' },
            { key: 'rtt', label: 'RTT', unit: 'ms' },
        ];

        // Ensure this peer's section exists in dynamic sections
        const existing = this.dynamicStatusSections.find((sec) => sec.id === sectionId);
        if (!existing) {
            this.dynamicStatusSections = [
                ...this.dynamicStatusSections,
                { id: sectionId, label: cname || `Link ${peerId}`, fields: peerFields },
            ];
        }

        // Track connected peers with timestamp
        this.peerLastSeen.set(peerId, Date.now());
        this.cleanupStalePeers();

        // Update badges
        this.setBadge('quality', {
            icon: 'signal',
            text: `${s.quality ?? 0}%`,
            color: s.quality >= 90 ? '#10b981' : s.quality >= 50 ? '#f59e0b' : '#ef4444',
        });
        const peerCount = this.peerLastSeen.size;
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
