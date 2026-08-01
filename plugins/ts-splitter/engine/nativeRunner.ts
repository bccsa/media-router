/**
 * Pure helpers for driving the native mr-tssplit child — kept free of module
 * state so the argv contract and event routing are unit-testable.
 *
 * The child speaks the engine's bus control verbs on stdin (bus_attach /
 * bus_detach / reinput — `NativeSinkController` shapes) and emits JSON events
 * on stdout, including `plugin_event` lines whose channel/payload are
 * byte-identical to what gst-pipeline-runner.py emitted for the tsSplit glue
 * — so `TsSplitterModule.onPluginEvent` is shared verbatim between both
 * generations of the data path.
 */
import { busTeeName } from '@media-router/engine';

/** Bus wire caps — identical to buildBusSink's capsfilter. */
export const BUS_TS_CAPS = 'video/mpegts, systemstream=(boolean)true, packetsize=(int)188';

export interface NativeOutput {
    pid: number;
    port: number;
    streamType?: number;
}

/** argv for mr-tssplit. ManagedProcess replays it verbatim on autoRestart,
 *  so everything the child needs is here — no post-spawn config. */
export function buildSpawnArgs(opts: {
    inputSocketPath: string;
    tsId?: number;
    outputs: NativeOutput[];
    /** Output coalescing window in ms (`--flush-ms`). 0 = broadcast every
     *  splitter batch immediately (ultra-low-latency; per-buffer fan-out
     *  costs return). Omitted = the runner's built-in 20 ms default. */
    busBatchMs?: number;
}): string[] {
    const args = ['--input', opts.inputSocketPath, '--caps', BUS_TS_CAPS];
    if (opts.tsId !== undefined) args.push('--ts-id', String(opts.tsId));
    if (opts.busBatchMs !== undefined) args.push('--flush-ms', String(opts.busBatchMs));
    for (const o of opts.outputs) {
        const stype = o.streamType !== undefined ? `:0x${o.streamType.toString(16)}` : '';
        args.push('--out', `0x${o.pid.toString(16)}:${busTeeName(o.port)}${stype}`);
    }
    return args;
}

export interface RunnerEventHandlers {
    onPluginEvent(channel: string, payload: unknown): void;
    onInputStalled(silentMs: number): void;
    onInputResumed(): void;
    onStats(stats: { clients?: number; in_kbps?: number }): void;
}

/**
 * Route one parsed runner stdout message (from `NativeSinkController.
 * handleLine`) to the module. Attach/detach/reinput events are already
 * consumed by the controller; everything else lands here.
 */
export function dispatchRunnerEvent(
    msg: Record<string, unknown>,
    handlers: RunnerEventHandlers,
): void {
    if (msg.event === 'plugin_event' && typeof msg.channel === 'string') {
        handlers.onPluginEvent(msg.channel, msg.payload);
    } else if (msg.event === 'input_stalled') {
        handlers.onInputStalled(Number(msg.ms) || 0);
    } else if (msg.event === 'input_resumed') {
        handlers.onInputResumed();
    } else if (msg.stats && typeof msg.stats === 'object') {
        handlers.onStats(msg.stats as { clients?: number; in_kbps?: number });
    }
}
