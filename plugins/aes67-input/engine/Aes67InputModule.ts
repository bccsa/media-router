import {
    GstPluginBase,
    aes67DepayloaderElement,
    aes67RtpCaps,
    buildBusSink,
    buildNetUdpSrc,
    clampChannels,
    clampPayloadType,
    interfaceAddress,
    isMulticastAddr,
    registerNetworkInterfaceDeviceProvider,
    resolvePythonScript,
    formatBytes,
    bitrateBadge,
    AES67_SAMPLE_RATE,
    NET_UDP_RCV_BUF,
    type Aes67Encoding,
    type EngineServices,
    type PipelineDescription,
} from '@media-router/engine';
import { build302mEncodeBranch, s302mFormatFor } from '@media-router/plugin-audio-302m-core';
import {
    aes67Discovery,
    registerAes67StreamDeviceProvider,
    streamId,
    type DiscoveredStream,
} from './sapDiscovery.js';

/**
 * AES67 / SMPTE ST 2110-30 input (ADR-0005 decision 7).
 *
 * Receives an L24/L16 48 kHz RTP audio stream off the network and republishes
 * it on the local bus as SMPTE-302M — the same shape as `audio-input-302m`,
 * with a network source instead of a capture device. It is a bus PRODUCER and
 * therefore a route head: `playoutOffsetMs` set here is the budget every player
 * fed from this stream presents against.
 *
 * Timing. The stream arrives with its own RTP timeline; the module does NOT
 * re-stamp it (no `do-timestamp`, no `tsparse set-timestamps`). Buffers reach
 * the `busout_*` tee carrying pipeline running time, and the engine's stamper
 * anchors that onto the house clock exactly as it does for every other
 * producer — so nothing here touches the time-sync contract's machinery.
 *
 * `ptpSync` adds RFC 7273 signalling to the receive caps and turns on the
 * jitterbuffer's `rfc7273-sync`, which schedules packets against the sender's
 * PTP media clock instead of arrival. It is OFF by default and gated on an
 * operator-supplied grandmaster id, because a receiver told to sync to a clock
 * that is not there simply stops producing audio.
 */
export class Aes67InputModule extends GstPluginBase {
    /** Route-head playout offset (ADR-0005 decision 4) — consumed downstream,
     *  never by this pipeline, so it is live and never pends a restart. */
    protected liveUpdatableParams = ['playoutOffsetMs'];

    private statsTimer: ReturnType<typeof setInterval> | null = null;
    /** Parameters taken from the picked SAP announcement, if it is being announced. */
    private pickedStream: DiscoveredStream | null = null;

    static registerServices(services: EngineServices): void {
        registerNetworkInterfaceDeviceProvider(services);
        registerAes67StreamDeviceProvider(services);
    }

    async onStart(): Promise<void> {
        if (this.services?.mediaRouter) {
            this.services.mediaRouter.assignBusChannel(this.services.instanceId);
        }
        // Discovery runs whether or not the pipeline can start: an unconfigured
        // module is exactly the one whose picker needs filling.
        this.startSapListener();
        this.resolvePickedStream();
        await super.onStart();

        this.childProcess?.on('stateChange', (data: { state: string }) => {
            if (data.state === 'stopped' || data.state === 'error') {
                this.setBadge('status', { icon: 'radio', text: 'Waiting', color: '#6b7280' });
                this.clearBadge('bitrate');
            }
        });
        this.statsTimer = setInterval(() => void this.pollStats(), 2000);
        this.updateStatusData();
    }

    async onStop(): Promise<void> {
        if (this.statsTimer) {
            clearInterval(this.statsTimer);
            this.statsTimer = null;
        }
        // The sidecar dies with the module (ProcessManager ownership), but the
        // streams it published would otherwise linger in every other module's
        // picker as sessions nobody is listening for any more.
        aes67Discovery.clear(this.services?.instanceId ?? '');
        await super.onStop();
    }

    /** SAP listener sidecar — one per running input module (see sapDiscovery.ts). */
    private startSapListener(): void {
        const script = resolvePythonScript('mr-sap.py', 'aes67-core');
        if (!script) {
            this.log.warn('mr-sap.py not found — AES67 stream discovery disabled');
            return;
        }
        const iface = interfaceAddress((this.config.interface as string) ?? '');
        this.spawnRunnerProcess({
            label: 'sap-discovery',
            command: 'python3',
            args: [script, '--listen', ...(iface ? ['--iface-address', iface] : [])],
            autoRestart: true,
            onStdout: (line) => this.handleSapLine(line),
        });
    }

    /** One JSON line from the SAP sidecar. Snapshots replace the table wholesale. */
    private handleSapLine(line: string): void {
        let msg: { event?: string; streams?: DiscoveredStream[]; message?: string };
        try {
            msg = JSON.parse(line) as typeof msg;
        } catch {
            return; // sidecar debug output — never fatal
        }
        if (msg.event === 'streams' && Array.isArray(msg.streams)) {
            aes67Discovery.publish(this.services?.instanceId ?? '', msg.streams);
            this.setStatusData('discovery', { discovered: aes67Discovery.list().length });
            this.resolvePickedStream();
        } else if (msg.event === 'error') {
            this.log.warn({ message: msg.message }, 'SAP sidecar error');
        }
    }

    /**
     * A picked stream supplies address/port/encoding/channels/payload type.
     *
     * The stored config keeps whatever the operator last had, so a stream that
     * stops being announced does NOT silently reconfigure the receiver — it
     * keeps running on the last known parameters and says so on the face.
     */
    private resolvePickedStream(): void {
        const picked = (this.config.discoveredStream as string) ?? '';
        if (!picked) {
            this.pickedStream = null;
            return;
        }
        const found = aes67Discovery.find(picked);
        if (found) this.pickedStream = found;
    }

    /** Effective stream parameters: a picked announcement wins over the manual fields. */
    private streamParams(config: Record<string, unknown>): {
        address: string;
        port: number;
        encoding: Aes67Encoding;
        channels: number;
        payloadType: number;
        fromDiscovery: boolean;
    } {
        const picked = (config.discoveredStream as string) ?? '';
        const s =
            picked && this.pickedStream && streamId(this.pickedStream) === picked
                ? this.pickedStream
                : null;
        const encoding = (
            s?.encoding === 'L16' || s?.encoding === 'L24'
                ? s.encoding
                : ((config.encoding as string) ?? 'L24')
        ) as Aes67Encoding;
        return {
            address: s?.address ?? (config.address as string) ?? '',
            port: s?.port ?? (config.port as number) ?? 5004,
            encoding: encoding === 'L16' ? 'L16' : 'L24',
            channels: clampChannels(s?.channels ?? (config.channels as number) ?? 2),
            payloadType: clampPayloadType(s?.payloadType ?? (config.payloadType as number) ?? 96),
            fromDiscovery: Boolean(s),
        };
    }

    buildPipeline(config: Record<string, unknown>): PipelineDescription | null {
        const instanceId = this.services?.instanceId ?? '';
        const endpoint = this.services?.mediaRouter?.getBusChannel(instanceId);
        if (!endpoint) {
            this.setHealth('error', 'No free bus channels available');
            return null;
        }

        const { address, port, encoding, channels, payloadType } = this.streamParams(config);
        if (!address) {
            // Same rule as the audio devices: never fall back to "whatever
            // arrives" — a receiver bound to 0.0.0.0 on a shared port picks up
            // an unrelated stream and plays it out on air.
            this.setHealth(
                'error',
                'No stream selected — pick a discovered stream or set an address',
            );
            return null;
        }

        const iface = (config.interface as string) ?? '';
        const multicast = isMulticastAddr(address);
        const jitterMs = Math.max(1, Math.min(500, Number(config.jitterBufferMs ?? 20)));
        const ptpSync = config.ptpSync === true;
        const gmid = ((config.ptpGmid as string) ?? '').trim();
        const ptpActive = ptpSync && gmid.length > 0;
        if (ptpSync && !ptpActive) {
            // Signalling nothing is recoverable; signalling a clock that isn't
            // there stalls the jitterbuffer and the stream goes silent.
            this.setHealth(
                'warning',
                'PTP sync needs a grandmaster ID — receiving without RFC 7273',
            );
        }

        const caps = aes67RtpCaps({
            encoding,
            channels,
            payloadType,
            ptpGmid: ptpActive ? gmid : undefined,
            ptpDomain: Number(config.ptpDomain ?? 0),
        });

        // 5 s of silence posts a udpsrc timeout the runner turns into a bus
        // error, so a dead sender restarts the pipeline instead of sitting
        // "connected" forever.
        const netSrc = buildNetUdpSrc({
            name: 'netsrc',
            port,
            multicastGroup: multicast ? address : undefined,
            iface: iface || undefined,
            caps,
            timeoutNs: 5_000_000_000,
            bufferSize: NET_UDP_RCV_BUF,
        });

        // rfc7273-sync makes the jitterbuffer schedule against the SENDER's PTP
        // media clock (it instantiates a GstPtpClock for the announced domain)
        // rather than against arrival — the whole point of an AES67 receiver,
        // and useless without a grandmaster on the network.
        const jitter =
            `rtpjitterbuffer name=jbuf latency=${jitterMs}` +
            (ptpActive ? ' rfc7273-sync=true add-reference-timestamp-meta=true' : '');

        // NOTE: no re-timestamping anywhere in this chain (time-sync contract).
        // This module encodes STEREO 302M (`build302mEncodeBranch()` default);
        // the format itself carries up to 8 channels (ADR-0014) and widening
        // AES67 ingest is a follow-up. A >2 ch stream is downmixed by
        // audioconvert and the operator is told so rather than silently losing
        // channels. Because the wire is fixed stereo whatever `channels` says,
        // this module deliberately declares no `getBusStreamChannels`.
        const pipeline = [
            netSrc,
            jitter,
            aes67DepayloaderElement(encoding),
            `audio/x-raw,rate=${AES67_SAMPLE_RATE}`,
            build302mEncodeBranch({ format: s302mFormatFor(config.pcmBitDepth) }),
            buildBusSink(endpoint.port),
        ].join(' ! ');

        if (channels > 2) {
            this.setHealth(
                'warning',
                `${channels}-channel stream downmixed to stereo on the 302M bus`,
            );
        } else {
            this.setHealth('ok');
        }

        this.setStatusData('bus', { channel: endpoint.port });
        return {
            pipeline,
            restartOnError: true,
            restartBackoffMs: { baseMs: 2000, maxMs: 10000 },
        };
    }

    private async pollStats(): Promise<void> {
        if (!this.running) return;
        const tp = await this.getThroughput();
        const t = tp['netsrc'];
        if (!t) {
            // Lazy registration: trackThroughput no-ops until the child pipeline
            // is PLAYING, and a restart spawns a fresh child with an empty map.
            await this.trackThroughput('netsrc', 'src');
            return;
        }
        this.setStatusData('stats', {
            bitrate: t.bitrate_mbps.toFixed(2),
            bytesReceived: formatBytes(t.total_bytes),
        });
        if (t.bitrate_mbps > 0) {
            this.setBadge('status', { icon: 'radio', text: 'Receiving', color: '#10b981' });
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
        const p = this.streamParams(this.config);
        const ptpSync = this.config.ptpSync === true;
        const gmid = ((this.config.ptpGmid as string) ?? '').trim();
        this.setStatusData('stream', {
            source: p.fromDiscovery ? `${p.address}:${p.port} (SAP)` : `${p.address}:${p.port}`,
            format: `${p.encoding} ${AES67_SAMPLE_RATE / 1000} kHz ${p.channels}ch`,
            payloadType: p.payloadType,
            multicast: isMulticastAddr(p.address) ? 'Yes' : 'No',
        });
        this.setStatusData('clock', {
            ptpSync: ptpSync && gmid ? `RFC 7273 (gm ${gmid})` : 'Off — arrival-scheduled',
        });
        this.setStatusData('discovery', { discovered: aes67Discovery.list().length });
    }
}
