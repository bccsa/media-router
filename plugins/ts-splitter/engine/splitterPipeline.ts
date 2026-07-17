/**
 * Pipeline/config builder for the TS-splitter — pure (no module instance), so
 * the exact gst strings are unit-testable under both bus transports.
 *
 * Shape: `<bus src> ! appsink name=splitin` (input chain) plus one
 * `appsrc ! <bus sink>` top-level chain per PID output. The runner's tsSplit
 * glue drains the appsink, routes packets per PID in a single pass
 * (ts_split.py) and pushes each PID's SPTS into its appsrc — packet-level
 * pass-through, output cadence = ingest cadence.
 *
 * All transport variance lives in buildUdpSrc/buildUdpSink: under unixfd the
 * input is the consumer's edge socket and each output ends at the fan-out tee
 * (`busout_<port>`); under UDP they are plain udpsrc/udpsink.
 */
import { buildUdpSink, buildUdpSrc, busTransport, type TsSplitRunnerConfig } from '@media-router/engine';

export const INPUT_APPSINK = 'splitin';

export function pidAppsrcName(pid: number): string {
    return `out_0x${pid.toString(16)}`;
}

export interface SplitterPipelineInput {
    input: { host: string; port: number; socketPath?: string };
    outputs: Array<{ pid: number; streamType?: number; host: string; port: number }>;
    tsId?: number;
}

export function buildSplitterPipeline(input: SplitterPipelineInput): {
    pipeline: string;
    tsSplit: TsSplitRunnerConfig;
} {
    const src = buildUdpSrc({
        host: input.input.host,
        port: input.input.port,
        socketPath: input.input.socketPath,
        name: 'netin',
    });
    // Under unixfd buildUdpSrc already ends in a 5 s leaky ingress queue.
    // Under UDP add one explicitly: it decouples udpsrc's socket-drain thread
    // from the python routing callback, so a stall sheds HERE (the bus's
    // universal drain contract) instead of overflowing the kernel rcvbuf.
    const ingressQueue =
        busTransport() === 'unixfd'
            ? ''
            : ' ! queue leaky=2 max-size-time=1000000000 max-size-buffers=0 max-size-bytes=0';
    const chains = [`${src}${ingressQueue} ! appsink name=${INPUT_APPSINK}`];

    for (const out of input.outputs) {
        // Same producer shape as rist-input's appsrc: live (no preroll —
        // satisfies the runner's playing watchdog), arrival-timestamped like
        // udpsrc, bounded+leaky so a stalled output sheds its own buffers
        // instead of growing memory or back-pressuring the router callback.
        // async=false on the UDP sink: appsrc's is-live does NOT exempt the
        // branch from preroll (verified gst 1.22 — the pipeline wedges in
        // PAUSED until data flows), and these outputs may legitimately be
        // dark. Ignored under unixfd (the chain ends at the fan-out tee).
        chains.push(
            `appsrc name=${pidAppsrcName(out.pid)} is-live=true do-timestamp=true format=time ` +
                'caps="video/mpegts, systemstream=(boolean)true, packetsize=(int)188" ' +
                'leaky-type=downstream max-bytes=4194304 ! ' +
                buildUdpSink({
                    host: out.host,
                    port: out.port,
                    name: `usink_0x${out.pid.toString(16)}`,
                    async: false,
                }),
        );
    }

    return {
        pipeline: chains.join(' '),
        tsSplit: {
            inputAppsink: INPUT_APPSINK,
            tsId: input.tsId ?? 1,
            outputs: input.outputs.map((o) => ({
                pid: o.pid,
                appsrc: pidAppsrcName(o.pid),
                streamType: o.streamType,
            })),
        },
    };
}
