import {
    GstPluginBase,
    isMulticast,
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
 * RIST Input plugin.
 *
 * Receives MPEG-TS from the network via RIST using the `ristreceiver` CLI tool
 * (spawned via ProcessManager). Outputs to local UDP multicast for downstream
 * decoders. Pure MPEG-TS passthrough.
 *
 * Uses CLI tools instead of GStreamer elements for full feature support:
 * per-link weight, cname, advanced profiles, encryption.
 */
export class RistInputModule extends GstPluginBase {
    private receiver: ManagedProcess | null = null;
    private lastStats: Record<string, string | number> = {};

    async onStart(): Promise<void> {
        // Assign UDP port for local multicast output
        if (this.services?.mediaRouter) {
            this.services.mediaRouter.assignUdpPort(this.services.instanceId);
        }

        const endpoint = this.services?.mediaRouter?.getUdpEndpoint(this.services.instanceId);
        if (!endpoint) {
            this.log.warn('No UDP port assigned — cannot output MPEG-TS');
            return;
        }

        // Build RIST input URLs from links config
        const links = (this.config.links as RistLink[]) ?? [
            { mode: 'listener', address: '0.0.0.0', port: 5004, weight: 50, cname: 'link1' },
        ];
        const inputUrls = links
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

        // The loopback bus is multicast: send to the group on lo, matching the
        // engine's group-bound consumer sockets (a 127.0.0.1 unicast send never
        // reaches them, so downstream modules hear silence).
        const outputUrl = isMulticast(endpoint.host)
            ? `udp://${endpoint.host}:${endpoint.port}?miface=lo`
            : `udp://${endpoint.host}:${endpoint.port}`;

        // Build CLI args
        const args = ['-i', inputUrls, '-o', outputUrl];
        const profile = (this.config.profile as number) ?? 1;
        const buffer = (this.config.buffer as number) ?? 1000;
        const secret = (this.config.secret as string) ?? '';
        const encType = (this.config.encryptionType as number) ?? 0;
        const statsInterval = (this.config.statsInterval as number) ?? 1000;

        args.push('-p', String(profile));
        args.push('-b', String(buffer));
        args.push('-S', String(statsInterval));
        args.push('-v', '6');
        if (secret) {
            args.push('-s', secret);
            args.push('-e', String(encType));
        }

        // Set running state immediately (no GStreamer pipeline — CLI is our process)
        this.running = true;
        this.ready = true;
        this.setHealth('ok');

        // Spawn ristreceiver via ProcessManager (shared health wiring:
        // restarting → warning, exhausted/spawn-fail → error, badges cleared)
        if (this.services?.processManager) {
            this.receiver = this.spawnRunnerProcess({
                label: 'ristreceiver',
                command: 'ristreceiver',
                args,
                autoRestart: true,
                clearBadges: ['quality', 'connections'],
                onStderr: (line) => {
                    if (line.includes('-stats"')) this.parseStats(line);
                },
            });
            this.receiver.on('started', () => this.setHealth('ok'));
        }

        // Update status display
        this.setStatusData('connection', {
            profile: ['simple', 'main', 'advanced'][profile] ?? 'main',
            linkCount: links.length,
            encrypted: secret ? 'Yes' : 'No',
        });

        // Don't call super.onStart() — no GStreamer pipeline needed (CLI handles everything)
    }

    async onStop(): Promise<void> {
        // ProcessManager auto-kills on module stop, but clear our reference
        this.receiver = null;
        this.lastStats = {};
        await super.onStop();
    }

    buildPipeline(_config: Record<string, unknown>): PipelineDescription | null {
        // No GStreamer pipeline — ristreceiver CLI handles the RIST → UDP conversion
        return null;
    }

    private parseStats(line: string): void {
        // RIST receiver outputs: {"receiver-stats":{"flowinstant":{"stats":{...},"peers":[{...}]}}}
        const jsonStart = line.indexOf('{');
        if (jsonStart < 0) return;
        try {
            const json = JSON.parse(line.substring(jsonStart));
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
        } catch {
            /* not a stats line */
        }
    }
}
