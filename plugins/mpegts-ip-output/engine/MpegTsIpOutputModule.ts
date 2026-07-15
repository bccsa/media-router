import {
    GstPluginBase,
    buildUdpSrc,
    buildNetUdpSink,
    buildBackpressureQueue,
    isMulticastAddr,
    formatBytes,
    bitrateBadge,
    registerNetworkInterfaceDeviceProvider,
    type PipelineDescription,
    type EngineServices,
} from '@media-router/engine';

interface Destination {
    host: string;
    port: number;
}

/**
 * MPEG-TS over IP output plugin.
 *
 * Receives local MPEG-TS off the loopback bus and sends it over the network as
 * plain UDP or RTP/TS. Pure passthrough — no encoding.
 *
 * UDP has no listener/caller handshake: a single multicast destination serves
 * unlimited receivers (they IGMP-join the group), while multiple unicast
 * destinations fan out via `tee → N udpsinks`. The network udpsinks bind a real
 * NIC via `buildNetUdpSink`, distinct from the `lo`-bound loopback source.
 */
export class MpegTsIpOutputModule extends GstPluginBase {
    private statsTimer: ReturnType<typeof setInterval> | null = null;

    static registerServices(services: EngineServices): void {
        registerNetworkInterfaceDeviceProvider(services);
    }

    async onStart(): Promise<void> {
        await super.onStart();

        this.childProcess?.on('stateChange', (data: { state: string }) => {
            if (data.state === 'stopped' || data.state === 'error') {
                this.setBadge('status', { icon: 'radio', text: 'Waiting', color: '#6b7280' });
                this.clearBadge('bitrate');
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
        await super.onStop();
    }

    buildPipeline(config: Record<string, unknown>): PipelineDescription | null {
        // Encapsulation is operator-configured. RTP (set per-flow) adds sequence
        // numbers so the receiver's rtpjitterbuffer reorders out-of-order UDP
        // datagrams — the fix for reordering-induced macroblocking on this path
        // (measured raw≈12 CC/35s → rtp=0). Defaults to raw for back-compat.
        const encapsulation = (config.encapsulation as string) ?? 'raw';
        const iface = (config.interface as string) ?? '';
        const ttl = (config.ttl as number) ?? 16;
        const destinations = this.resolveDestinations(config);

        const instanceId = this.services?.instanceId ?? '';
        const udpSource = this.services?.mediaRouter?.getModuleUdpSource(instanceId);
        if (!udpSource) {
            this.log.info('No MPEG-TS source connected — idle');
            return null;
        }
        if (destinations.length === 0) {
            this.log.warn('No destinations configured — cannot send MPEG-TS');
            return null;
        }

        // Loopback source → back-pressure queue → optional RTP payloader.
        // NON-leaky: on a clean link the network udpsink drains faster than the
        // feed, so this queue sits near-empty (≈0 latency) and merely buffers a
        // transient burst (a big I-frame off the loopback bus) instead of
        // SHEDDING TS packets before they hit the wire. A leaky queue here
        // corrupts the stream at the source — the receiver then sees continuity
        // gaps / macroblocking it can never recover (plain MPEG-TS/UDP has no
        // retransmit). Don't drop on the sender when the wire isn't dropping.
        const head = [
            buildUdpSrc({
                name: 'busin',
                host: udpSource.host,
                port: udpSource.port,
                socketPath: udpSource.socketPath,
            }),
            buildBackpressureQueue(200),
        ];
        if (encapsulation === 'rtp') head.push('rtpmp2tpay');

        const makeSink = (dest: Destination, name: string): string =>
            buildNetUdpSink({
                name,
                host: dest.host,
                port: dest.port,
                iface: isMulticastAddr(dest.host) && iface ? iface : undefined,
                ttl,
            });

        let pipeline: string;
        if (destinations.length === 1) {
            pipeline = [...head, makeSink(destinations[0], 'netsink')].join(' ! ');
        } else {
            // tee → one queued udpsink branch per destination.
            const branches = destinations
                .map((d, i) => `t. ! ${buildBackpressureQueue(200)} ! ${makeSink(d, `netsink${i}`)}`)
                .join(' ');
            pipeline = `${head.join(' ! ')} ! tee name=t ${branches}`;
        }

        return {
            pipeline,
            restartOnError: true,
            restartBackoffMs: { baseMs: 2000, maxMs: 10000 },
        };
    }

    /** Normalise the destinations array, dropping entries without a host/port. */
    private resolveDestinations(config: Record<string, unknown>): Destination[] {
        const raw = Array.isArray(config.destinations) ? config.destinations : [];
        return raw
            .map((d) => d as Partial<Destination>)
            .filter((d): d is Destination => typeof d.host === 'string' && d.host.length > 0 && typeof d.port === 'number');
    }

    private async pollStats(): Promise<void> {
        if (!this.running) return;
        const tp = await this.getThroughput();
        const t = tp['busin'];
        if (!t) {
            // No tracker yet. Registering once in onStart races the PLAYING
            // transition — trackThroughput no-ops until the child pipeline is
            // live, so the pad probe never attaches and stats stay blank. A
            // pipeline restart likewise spawns a fresh Python child with an
            // empty tracker map. (Re)establish it here on the live poll loop;
            // the next tick reads the freshly-attached counter.
            await this.trackThroughput('busin', 'src');
            return;
        }
        const flowing = t.bitrate_mbps > 0;
        // Popup carries the exact bitrate/bytes. The face shows TWO badges when
        // flowing: an SRT-style status word ("Connected") plus a live bitrate
        // badge. "Stalled" (amber) means the feed dried up after data had flowed;
        // "Waiting" (grey) means nothing has been sent yet. The bitrate badge is
        // cleared when not flowing so a stale rate never lingers.
        this.setStatusData('stats', {
            bitrate: t.bitrate_mbps.toFixed(2),
            bytesSent: formatBytes(t.total_bytes),
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
        const destinations = this.resolveDestinations(this.config);
        const anyMulticast = destinations.some((d) => isMulticastAddr(d.host));
        this.setStatusData('connection', {
            encapsulation: (this.config.encapsulation as string) ?? 'raw',
            destinations: destinations.map((d) => `${d.host}:${d.port}`).join(', ') || '—',
        });
        this.setBadge('dests', {
            icon: anyMulticast ? 'cast' : 'arrow-up-from-line',
            text: String(destinations.length),
            color: '#0284c7',
        });
    }
}
