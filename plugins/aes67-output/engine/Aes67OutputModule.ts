import {
    GstPluginBase,
    aes67PayloaderElement,
    aes67PayloadBytes,
    aes67PtimeClauses,
    aes67RawCaps,
    buildBusSrc,
    buildBackpressureQueue,
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
import { spawn } from 'node:child_process';

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
 * measured once at start by `aes67-core/py/aes67_clock.py`. It stays valid
 * because CLOCK_MONOTONIC carries the same NTP/PTP frequency discipline as
 * CLOCK_REALTIME (`man 2 clock_gettime`), so their difference moves only on a
 * clock STEP — which the module re-measures for, rather than pretending it
 * cannot happen. NO TAI pipeline clock is needed, and the house clock stays
 * the house clock: nothing about the contract changes for this pipeline.
 *
 * `ptpSync` is off by default and REFUSES to claim the epoch on a box whose
 * kernel TAI offset is unset (no ptp4l/phc2sys): the payloader then keeps its
 * random RFC 3550 offset, the SDP carries no `ts-refclk`/`mediaclk`, and the
 * face says so. A free-running sender is honest; a sender announcing a PTP
 * media clock it does not have is undetectable at the receiver.
 */
export class Aes67OutputModule extends GstPluginBase {
    private statsTimer: ReturnType<typeof setInterval> | null = null;
    /** Epoch measurement from the last start; null = free-running timestamps. */
    private epoch: { rtpTimestampOffset: number; taiOffsetS: number } | null = null;
    private epochError = '';

    static registerServices(services: EngineServices): void {
        registerNetworkInterfaceDeviceProvider(services);
    }

    async onStart(): Promise<void> {
        // Measured BEFORE the pipeline is built (same shape as mpegts-ip-input's
        // encapsulation sniff): buildPipeline is synchronous and needs the number.
        await this.measureEpoch();
        await super.onStart();
        this.startSapAnnouncer();

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
        if (this.statsTimer) {
            clearInterval(this.statsTimer);
            this.statsTimer = null;
        }
        this.epoch = null;
        this.epochError = '';
        await super.onStop();
    }

    /**
     * Read the TAI↔monotonic relationship through the shared python helper, so
     * the epoch arithmetic has ONE definition (in `aes67-core`) rather than a
     * TypeScript copy that can drift from the one the tests pin.
     */
    private async measureEpoch(): Promise<void> {
        this.epoch = null;
        this.epochError = '';
        if (this.config.ptpSync !== true) return;
        if (!this.services?.timeSyncContract) {
            // Without the contract, running time is a per-start base time and
            // the offset would map onto an arbitrary origin — a wrong epoch, not
            // a missing one.
            this.epochError = 'time-sync contract is off — RTP timestamps free-run';
            return;
        }
        const script = resolvePythonScript('aes67_clock.py', 'aes67-core');
        if (!script) {
            this.epochError = 'aes67_clock.py not found — RTP timestamps free-run';
            return;
        }
        try {
            const state = await runJson(script);
            if (state.disciplined && typeof state.rtpTimestampOffset === 'number') {
                this.epoch = {
                    rtpTimestampOffset: state.rtpTimestampOffset,
                    taiOffsetS: Number(state.taiOffsetS ?? 0),
                };
            } else {
                this.epochError =
                    'system clock is not PTP/TAI disciplined — RTP timestamps free-run';
            }
        } catch (err) {
            this.epochError = `clock probe failed (${String(err)}) — RTP timestamps free-run`;
        }
        if (this.epochError)
            this.log.warn({ reason: this.epochError }, 'AES67 epoch alignment off');
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
        const contract = this.services?.timeSyncContract === true;
        const senderLatencyNs =
            Math.max(0, Math.min(500, Number(config.senderLatencyMs ?? 20))) * 1_000_000;
        const sinkSync = contract
            ? `sync=true max-lateness=-1 ts-offset=${senderLatencyNs}`
            : 'sync=false';

        const dscp = Math.max(-1, Math.min(63, Number(config.dscp ?? AES67_DEFAULT_DSCP)));
        const multicast = isMulticastAddr(p.address);
        const iface = (config.interface as string) ?? '';
        const ifaceClause = multicast && iface ? ` multicast-iface=${iface}` : '';
        const ttlClause = multicast ? ` auto-multicast=true ttl-mc=${p.ttl}` : ` ttl=${p.ttl}`;

        // timestamp-offset is only pinned when the epoch was really measured;
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
            `udpsink name=netsink host=${p.address} port=${p.port}${ifaceClause}${ttlClause}` +
                ` qos-dscp=${dscp} ${sinkSync}`,
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
        this.setStatusData('clock', {
            epoch: this.epoch
                ? `PTP epoch (TAI-UTC ${this.epoch.taiOffsetS}s, offset ${this.epoch.rtpTimestampOffset})`
                : this.config.ptpSync === true
                  ? `Free-running — ${this.epochError}`
                  : 'Free-running (PTP sync off)',
        });
    }
}

/** Run a python helper that prints one JSON object, and parse it. */
async function runJson(script: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        const child = spawn('python3', [script, '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        child.stdout.on('data', (d: Buffer) => (out += d.toString()));
        child.stderr.on('data', (d: Buffer) => (err += d.toString()));
        child.on('error', reject);
        child.on('close', (code) => {
            if (code !== 0) return reject(new Error(err.trim() || `exit ${code}`));
            try {
                resolve(JSON.parse(out) as Record<string, unknown>);
            } catch (e) {
                reject(e instanceof Error ? e : new Error(String(e)));
            }
        });
    });
}
