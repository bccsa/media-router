import {
    GstPluginBase,
    buildTsRepackRelayArgs,
    type PipelineDescription,
    type ModuleServices,
} from '@media-router/engine';
import type { ManagedProcess } from '@media-router/engine';

interface RistLink {
    mode: 'listener' | 'caller';
    address: string;
    port: number;
    weight: number;
    cname: string;
}

/**
 * RIST Output plugin.
 *
 * Receives local MPEG-TS via UDP multicast and sends it over the network
 * via RIST using the `ristsender` CLI tool (spawned via ProcessManager).
 * Pure MPEG-TS passthrough.
 *
 * Uses CLI tools for full feature support: per-link weight, cname,
 * advanced profiles, encryption, NPD.
 */
export class RistOutputModule extends GstPluginBase {
    private sender: ManagedProcess | null = null;
    private relay: ManagedProcess | null = null;
    private lastStats: Record<string, string | number> = {};
    private peerLastSeen = new Map<number, number>(); // peerId → timestamp
    private peerCleanupTimer: ReturnType<typeof setInterval> | null = null;

    async onStart(): Promise<void> {
        // Get the UDP source from the connected encoder/srt-input
        const instanceId = this.services?.instanceId ?? '';
        const udpSource = this.services?.mediaRouter?.getModuleUdpSource(instanceId);
        if (!udpSource) {
            this.log.info('No MPEG-TS source connected — idle');
            return;
        }

        // Re-pack the 188-byte internal bus to wire-sized datagrams before RIST:
        // a sidecar `gst-launch tsparse alignment=N` relay reads the multicast bus,
        // packs to N×188 B (default 7 = 1316), and forwards to a PRIVATE loopback
        // port that ristsender (UDP-only, no stdio) reads. Without this, ristsender
        // would RIST-wrap 188-byte payloads (7× the per-packet overhead).
        const packetsPerDatagram = (this.config.packetsPerDatagram as number) ?? 7;
        const priv = this.services?.mediaRouter?.assignUdpPort(instanceId, 'rist-repack');
        if (!priv) {
            this.log.warn('No private UDP port for repack relay — cannot send');
            return;
        }
        const inputUrl = `udp://127.0.0.1:${priv.port}`;

        // Build RIST output URLs from links config
        const links = (this.config.links as RistLink[]) ?? [
            { mode: 'caller', address: 'localhost', port: 5004, weight: 50, cname: 'link1' },
        ];
        const outputUrls = links
            .map((link) => {
                const params: string[] = [];
                if (link.weight !== undefined) params.push(`weight=${link.weight}`);
                if (link.cname) params.push(`cname=${link.cname}`);
                // RIST URL: rist://@host:port for listener, rist://host:port for caller
                const addr =
                    link.mode === 'listener'
                        ? `@${link.address || '0.0.0.0'}`
                        : link.address || 'localhost';
                return `rist://${addr}:${link.port}${params.length ? '?' + params.join('&') : ''}`;
            })
            .join(',');

        // Build CLI args
        const args = ['-i', inputUrl, '-o', outputUrls];
        const profile = (this.config.profile as number) ?? 1;
        const buffer = (this.config.buffer as number) ?? 1000;
        const secret = (this.config.secret as string) ?? '';
        const encType = (this.config.encryptionType as number) ?? 0;
        const statsInterval = (this.config.statsInterval as number) ?? 1000;
        const npd = (this.config.nullPacketDeletion as boolean) ?? false;

        args.push('-p', String(profile));
        args.push('-b', String(buffer));
        args.push('-S', String(statsInterval));
        args.push('-v', '6');
        if (secret) {
            args.push('-s', secret);
            args.push('-e', String(encType));
        }
        if (npd) args.push('-n');

        // Set running state immediately (no GStreamer pipeline — CLI is our process)
        this.running = true;
        this.ready = true;
        this.setHealth('ok');

        // Spawn ristsender via ProcessManager (shared health wiring:
        // restarting → warning, exhausted/spawn-fail → error, badges cleared)
        if (this.services?.processManager) {
            // Sidecar relay: multicast bus → tsparse alignment=N → private port.
            this.relay = this.spawnRunnerProcess({
                label: 'repack-relay',
                command: 'gst-launch-1.0',
                args: buildTsRepackRelayArgs({
                    in: { host: udpSource.host, port: udpSource.port },
                    out: { host: '127.0.0.1', port: priv.port },
                    alignment: packetsPerDatagram,
                }),
                autoRestart: true,
            });
            this.sender = this.spawnRunnerProcess({
                label: 'ristsender',
                command: 'ristsender',
                args,
                autoRestart: true,
                clearBadges: ['quality', 'connections'],
                onStderr: (line) => {
                    if (line.includes('-stats"')) this.parseStats(line);
                    // Non-stats lines are logged by ManagedProcess at warn level
                },
            });
            this.sender.on('started', () => this.setHealth('ok'));
        }

        // Update status display
        this.setStatusData('connection', {
            profile: ['simple', 'main', 'advanced'][profile] ?? 'main',
            linkCount: links.length,
            encrypted: secret ? 'Yes' : 'No',
        });

        // Periodic cleanup of stale peers (detect disconnects even when no new stats arrive)
        this.peerCleanupTimer = setInterval(() => this.cleanupStalePeers(), 2000);

        // Don't call super.onStart() — no GStreamer pipeline needed
    }

    async onStop(): Promise<void> {
        if (this.peerCleanupTimer) {
            clearInterval(this.peerCleanupTimer);
            this.peerCleanupTimer = null;
        }
        this.sender = null;
        this.relay = null;
        this.lastStats = {};
        this.peerLastSeen.clear();
        await super.onStop();
    }

    buildPipeline(_config: Record<string, unknown>): PipelineDescription | null {
        // No GStreamer pipeline — ristsender CLI handles the UDP → RIST conversion
        return null;
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

    private parseStats(line: string): void {
        // RIST CLI outputs one JSON line per peer per stats interval
        const jsonStart = line.indexOf('{');
        if (jsonStart < 0) return;
        try {
            const json = JSON.parse(line.substring(jsonStart));
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
                rtt:
                    typeof s.avg_rtt === 'number'
                        ? `${s.avg_rtt.toFixed(2)}`
                        : String(s.rtt ?? '—'),
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
        } catch {
            /* not a stats line */
        }
    }
}
