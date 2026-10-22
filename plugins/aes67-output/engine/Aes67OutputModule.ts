import {
    GstPluginBase,
    aes67PayloaderElement,
    aes67PayloadBytes,
    aes67PtimeClauses,
    aes67RawCaps,
    buildBusSrc,
    buildBackpressureQueue,
    withLatenessTap,
    clampChannels,
    clampPayloadType,
    clampPtime,
    interfaceAddress,
    isMulticastAddr,
    registerNetworkInterfaceDeviceProvider,
    resolvePythonScript,
    formatBytes,
    bitrateBadge,
    AES67_DEFAULT_DSCP,
    AES67_SAMPLE_RATE,
    type Aes67Encoding,
    type EngineServices,
    type PipelineDescription,
} from '@media-router/engine';
import {
    claimEpoch,
    epochChangeNeedsRestart,
    epochRefusal,
    type Aes67Epoch,
} from './aes67Epoch.js';

/**
 * AES67 / SMPTE ST 2110-30 output (ADR-0005 decision 7).
 *
 * Takes SMPTE-302M off the local bus and sends it to the network as an AES67
 * RTP stream: L24/L16, 48 kHz, 1 ms packets, DSCP EF, optionally announced
 * over SAP so other devices can discover it.
 *
 * ## RTP timestamps and the PTP epoch
 *
 * A conformant AES67 sender's RTP timestamp is the media clock counted from
 * the PTP epoch, so two senders locked to the same grandmaster describe the
 * same instant with the same number. GStreamer's payloader computes
 * `rtptime = timestamp-offset + running_time x 48000 / 1e9` from the ABSOLUTE
 * running time (measured, not assumed — `aes67-core/tests/aes67Gst.test.ts`),
 * and under the time-sync contract running time IS CLOCK_MONOTONIC
 * (`base_time=0`, ADR-0005 decision 3). So the epoch is one integer:
 *
 *     timestamp-offset = ((CLOCK_TAI - CLOCK_MONOTONIC) x 48000 / 1e9) mod 2^32
 *
 * i.e. the engine's house epoch E (`services.houseClock`, design §4.2), one E for every egress
 * on the box. E moves only on a clock step; this module then restarts on `epoch` so the new
 * offset lands (one flagged discontinuity, §10.3). NO TAI pipeline clock is needed.
 *
 * `ptpSync` is off by default and REFUSES to claim the epoch while the engine's epoch is
 * untraceable (no sync, or the kernel TAI offset unset): the payloader then keeps its
 * random RFC 3550 offset, the SDP carries no `ts-refclk`/`mediaclk`, and the
 * face says so. A free-running sender is honest; a sender announcing a PTP
 * media clock it does not have is undetectable at the receiver.
 */
export class Aes67OutputModule extends GstPluginBase {
    private statsTimer: ReturnType<typeof setInterval> | null = null;
    /** The house epoch this run claims; null = free-running timestamps. */
    private epoch: Aes67Epoch | null = null;
    private epochError = '';
    /** The latest house-clock restart. */
    private epochRestart: Promise<void> | null = null;
    /** One-shot token for restartForEpoch's own onStop; any other stop is the engine's. */
    private selfRestarting = false;
    private externalStop = false;

    static registerServices(services: EngineServices): void {
        registerNetworkInterfaceDeviceProvider(services);
    }

    async onStart(): Promise<void> {
        this.externalStop = false;
        // Resolved BEFORE the pipeline is built: buildPipeline is synchronous.
        await this.resolveEpoch();
        await super.onStart();
        this.startSapAnnouncer();
        // No event-loop turn passes between resolveEpoch()'s read and here (the in-process
        // runner answers startPipeline at once), so no clock change is missed.
        this.services?.houseClock?.on('epoch', this.onClockChange);
        this.services?.houseClock?.on('state', this.onClockChange);

        this.childProcess?.on('stateChange', (data: { state: string }) => {
            if (data.state === 'stopped' || data.state === 'error') {
                this.setBadge('status', { icon: 'radio', text: 'Idle', color: '#6b7280' });
                this.clearBadge('bitrate');
            }
        });
        this.statsTimer = setInterval(() => void this.pollStats(), 2000);
        this.updateStatusData();
    }

    async onStop(): Promise<void> {
        // Consumed on entry, so an engine stop landing mid-restart still counts as external.
        if (!this.selfRestarting) this.externalStop = true;
        this.selfRestarting = false;
        // Off before the first await: no clock change reaches a restart in flight.
        this.services?.houseClock?.off('epoch', this.onClockChange);
        this.services?.houseClock?.off('state', this.onClockChange);
        if (this.statsTimer) {
            clearInterval(this.statsTimer);
            this.statsTimer = null;
        }
        this.epoch = null;
        this.epochError = '';
        await super.onStop();
    }

    /** Claim the engine's E when `ptpSync` asks for it and the epoch is traceable. */
    private async resolveEpoch(): Promise<void> {
        this.epoch = null;
        this.epochError = '';
        if (this.config.ptpSync !== true) return;
        const clock = this.services?.houseClock;
        // Modules start after ready() already; the latest epoch may be newer.
        await clock?.ready();
        this.epochError = epochRefusal(clock);
        if (!this.epochError) this.epoch = claimEpoch(clock!.epoch()!);
        else this.log.warn({ reason: this.epochError }, 'AES67 epoch alignment off');
    }

    /** A re-latch (or newly traceable epoch) restarts the sender so the new offset lands. */
    private readonly onClockChange = (): void => {
        if (!this.running || this.config.ptpSync !== true) return;
        const clock = this.services?.houseClock;
        if (!epochChangeNeedsRestart(this.epoch, clock?.epoch() ?? null)) {
            // Still free-running: the reason follows the clock, not the last start.
            if (!this.epoch) this.epochError = epochRefusal(clock);
            this.updateStatusData();
            return;
        }
        this.epochRestart = this.restartForEpoch().catch((err: unknown) =>
            this.log.error({ err }, 'AES67 epoch restart failed'),
        );
    };

    /** A move made while this stops is not lost: the onStart below reads the clock afresh. */
    private async restartForEpoch(): Promise<void> {
        this.log.info('House epoch changed — restarting so the new timestamp-offset lands');
        this.selfRestarting = true;
        await this.onStop();
        // Stopped by the engine meanwhile: do not revive it.
        if (this.externalStop) return;
        await this.onStart();
    }

    /** SAP announcement sidecar — announces while the module runs, deletes on stop. */
    private startSapAnnouncer(): void {
        if (this.config.sapEnabled === false) return;
        const script = resolvePythonScript('mr-sap.py', 'aes67-core');
        if (!script) {
            this.log.warn('mr-sap.py not found — SAP announcements disabled');
            return;
        }
        const p = this.streamParams(this.config);
        if (!p.address) return;
        const iface = interfaceAddress((this.config.interface as string) ?? '');
        // The RFC 7273 pair is announced only when this sender really is on the
        // PTP epoch — see the class comment.
        const gmid = this.epoch ? ((this.config.ptpGmid as string) ?? '').trim() : '';

        const args = [script, '--announce'];
        const arg = (flag: string, value: string | number): number =>
            args.push(flag, String(value));
        arg('--session-name', this.sessionName());
        arg('--stream-address', p.address);
        arg('--stream-port', p.port);
        arg('--encoding', p.encoding);
        arg('--rate', AES67_SAMPLE_RATE);
        arg('--channels', p.channels);
        arg('--ptime', p.ptimeMs);
        arg('--payload-type', p.payloadType);
        arg('--ttl', p.ttl);
        arg('--interval', Number(this.config.sapIntervalS ?? 30));
        if (iface) arg('--iface-address', iface);
        if (gmid) {
            arg('--ptp-gmid', gmid);
            arg('--ptp-domain', Number(this.config.ptpDomain ?? 0));
        }

        this.spawnRunnerProcess({
            label: 'sap-announce',
            command: 'python3',
            args,
            autoRestart: true,
            onStdout: (line) => this.handleSapLine(line),
        });
    }

    private handleSapLine(line: string): void {
        try {
            const msg = JSON.parse(line) as { event?: string; message?: string };
            if (msg.event === 'error') this.log.warn({ message: msg.message }, 'SAP sidecar error');
        } catch {
            /* sidecar debug output */
        }
    }

    private sessionName(): string {
        const configured = ((this.config.sessionName as string) ?? '').trim();
        return configured || `Media Router ${this.services?.instanceId ?? 'AES67'}`;
    }

    private streamParams(config: Record<string, unknown>): {
        address: string;
        port: number;
        encoding: Aes67Encoding;
        channels: number;
        payloadType: number;
        ptimeMs: number;
        ttl: number;
    } {
        const encoding = ((config.encoding as string) ?? 'L24') === 'L16' ? 'L16' : 'L24';
        return {
            address: ((config.address as string) ?? '').trim(),
            port: Number(config.port ?? 5004),
            encoding,
            channels: clampChannels(Number(config.channels ?? 2)),
            payloadType: clampPayloadType(Number(config.payloadType ?? 96)),
            ptimeMs: clampPtime(Number(config.ptimeMs ?? 1)),
            ttl: Number(config.ttl ?? 16),
        };
    }

    buildPipeline(config: Record<string, unknown>): PipelineDescription | null {
        const instanceId = this.services?.instanceId ?? '';
        const source = this.services?.mediaRouter?.getModuleBusSource(instanceId);
        if (!source) {
            this.setHealth('warning', 'No 302M source connected');
            return null;
        }
        const p = this.streamParams(config);
        if (!p.address) {
            this.setHealth('error', 'No destination address configured');
            return null;
        }

        const mtu = Math.max(576, Math.min(9000, Number(config.mtu ?? 1452)));
        const payloadBytes = aes67PayloadBytes(p.encoding, p.channels, p.ptimeMs);
        if (payloadBytes + 12 > mtu) {
            // RTP header is 12 bytes; a packet that cannot fit gets fragmented
            // by the payloader into something no AES67 receiver expects.
            this.setHealth(
                'error',
                `${p.ptimeMs} ms of ${p.channels}ch ${p.encoding} is ${payloadBytes} B — over the ${mtu} B MTU`,
            );
            return null;
        }

        // Pacing. The payloader emits one buffer per packet time; something has
        // to space them or they leave in decode-sized bursts. A syncing sink
        // does it against the house clock, which needs a scheduling margin —
        // that is what senderLatencyMs is, and it is NOT the route's playout
        // offset D: delaying an AES67 egress by D would spend the RECEIVER's
        // link-offset budget on our side of the wire, while the RTP timestamps
        // (which carry the alignment) stay unchanged either way.
        const senderLatencyNs =
            Math.max(0, Math.min(500, Number(config.senderLatencyMs ?? 20))) * 1_000_000;
        const sinkSync = `sync=true max-lateness=-1 ts-offset=${senderLatencyNs}`;

        const dscp = Math.max(-1, Math.min(63, Number(config.dscp ?? AES67_DEFAULT_DSCP)));
        const multicast = isMulticastAddr(p.address);
        const iface = (config.interface as string) ?? '';
        const ifaceClause = multicast && iface ? ` multicast-iface=${iface}` : '';
        const ttlClause = multicast ? ` auto-multicast=true ttl-mc=${p.ttl}` : ` ttl=${p.ttl}`;

        // timestamp-offset is only pinned when the epoch is really claimed;
        // otherwise the payloader keeps its random RFC 3550 offset.
        const tsOffsetClause = this.epoch
            ? ` timestamp-offset=${this.epoch.rtpTimestampOffset}`
            : '';

        const pipeline = [
            buildBusSrc({ name: 'busin', port: source.port, socketPath: source.socketPath }),
            buildBackpressureQueue(200),
            'tsdemux latency=0',
            'audio/x-smpte-302m',
            'avdec_s302m',
            'audioconvert',
            'audioresample',
            aes67RawCaps(p.encoding, p.channels),
            `${aes67PayloaderElement(p.encoding)} name=pay pt=${p.payloadType} mtu=${mtu}` +
                ` ${aes67PtimeClauses(p.ptimeMs)}${tsOffsetClause}`,
            withLatenessTap(
                'lat_egress',
                `udpsink name=netsink host=${p.address} port=${p.port}${ifaceClause}${ttlClause}` +
                    ` qos-dscp=${dscp} ${sinkSync}`,
            ),
        ].join(' ! ');

        if (config.ptpSync === true && !this.epoch) {
            this.setHealth('warning', this.epochError || 'RTP timestamps free-run');
        } else {
            this.setHealth('ok');
        }

        return {
            pipeline,
            restartOnError: true,
            restartBackoffMs: { baseMs: 2000, maxMs: 10000 },
        };
    }

    private async pollStats(): Promise<void> {
        if (!this.running) return;
        const tp = await this.getThroughput();
        const t = tp['busin'];
        if (!t) {
            await this.trackThroughput('busin', 'src');
            return;
        }
        this.setStatusData('stats', {
            bitrate: t.bitrate_mbps.toFixed(2),
            bytesSent: formatBytes(t.total_bytes),
        });
        if (t.bitrate_mbps > 0) {
            this.setBadge('status', { icon: 'radio', text: 'Sending', color: '#10b981' });
            this.setBadge('bitrate', bitrateBadge(Math.round(t.bitrate_mbps * 1000)));
        } else {
            this.setBadge('status', {
                icon: 'radio',
                text: t.total_bytes > 0 ? 'Stalled' : 'Idle',
                color: t.total_bytes > 0 ? '#f59e0b' : '#6b7280',
            });
            this.clearBadge('bitrate');
        }
    }

    private updateStatusData(): void {
        const p = this.streamParams(this.config);
        this.setStatusData('stream', {
            destination: `${p.address}:${p.port}`,
            format: `${p.encoding} ${AES67_SAMPLE_RATE / 1000} kHz ${p.channels}ch`,
            packetTime: `${p.ptimeMs} ms`,
            multicast: isMulticastAddr(p.address) ? 'Yes' : 'No',
        });
        const clock = this.services?.houseClock;
        const lost = this.epoch && clock?.epoch()?.traceable === false;
        this.setStatusData('clock', {
            epoch: this.epoch
                ? `PTP epoch (TAI-UTC ${this.epoch.taiOffsetS}s, offset ${this.epoch.rtpTimestampOffset})` +
                  (lost ? ' — sync lost since, E kept' : '')
                : this.config.ptpSync === true
                  ? `Free-running — ${this.epochError}`
                  : 'Free-running (PTP sync off)',
            epochSeq: this.epoch?.seq ?? clock?.epoch()?.seq ?? 0,
            timeSource: clock?.state().source ?? 'none',
        });
    }
}
