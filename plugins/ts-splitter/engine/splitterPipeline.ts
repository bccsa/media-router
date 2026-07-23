/**
 * Pipeline/config builder for the TS-splitter — pure (no module instance), so
 * the exact gst strings are unit-testable.
 *
 * Shape: `<bus src> ! appsink name=splitin` (input chain) plus one
 * `appsrc ! <bus sink>` top-level chain per PID output. The runner's tsSplit
 * glue drains the appsink, routes packets per PID in a single pass
 * (ts_split.py) and pushes each PID's SPTS into its appsrc — packet-level
 * pass-through, output cadence = ingest cadence.
 *
 * The input is the consumer's edge socket (`buildBusSrc`) and each output
 * ends at the fan-out tee (`busout_<port>`, `buildBusSink`).
 */
import { buildBusSink, buildBusSrc, type TsSplitRunnerConfig } from '@media-router/engine';

export const INPUT_APPSINK = 'splitin';

/** `name=` of the input `unixfdsrc` — the target of the engine's live
 *  input-swap (`bus_reinput`): the source edge can be re-pointed without
 *  restarting this module, so its output appsrc chains (and every
 *  downstream consumer) stay up across a head-end source switch. */
export const INPUT_SRC_NAME = 'netin';

export function pidAppsrcName(pid: number): string {
    return `out_0x${pid.toString(16)}`;
}

export interface SplitterPipelineInput {
    input: { port: number; socketPath?: string };
    outputs: Array<{ pid: number; streamType?: number; port: number }>;
    tsId?: number;
}

export function buildSplitterPipeline(input: SplitterPipelineInput): {
    pipeline: string;
    tsSplit: TsSplitRunnerConfig;
} {
    // buildBusSrc already ends in a 5 s leaky ingress queue — it decouples
    // the socket-drain thread from the python routing callback, so a stall
    // sheds THERE (the bus's universal drain contract).
    const src = buildBusSrc({
        port: input.input.port,
        socketPath: input.input.socketPath,
        name: INPUT_SRC_NAME,
    });
    const chains = [`${src} ! appsink name=${INPUT_APPSINK}`];

    for (const out of input.outputs) {
        // Same producer shape as rist-input's appsrc: live (no preroll —
        // satisfies the runner's playing watchdog), arrival-timestamped,
        // bounded+leaky so a stalled output sheds its own buffers instead of
        // growing memory or back-pressuring the router callback. The chain
        // ends at the fan-out tee, so no preroll concern on dark outputs.
        chains.push(
            `appsrc name=${pidAppsrcName(out.pid)} is-live=true do-timestamp=true format=time ` +
                'caps="video/mpegts, systemstream=(boolean)true, packetsize=(int)188" ' +
                'leaky-type=downstream max-bytes=4194304 ! ' +
                buildBusSink(out.port),
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
                // Enables wired-only gating: the runner produces this output
                // only while its busout tee has an attached fan-out edge.
                port: o.port,
            })),
        },
    };
}
