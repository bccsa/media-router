import { execFile } from 'child_process';
import { promisify } from 'util';
import { createLogger, formatError } from '@media-router/shared-types';

const log = createLogger('StreamPortLinks');
const execFileAsync = promisify(execFile);

/**
 * Explicit device links for an engine stream (ADR-0014, 2026-09-15 amendment).
 *
 * WirePlumber links a stream to a device by channel POSITION, and a stream of
 * ≤ 8 channels gets FL/FR/… defaults that never match a multichannel card's
 * AUX-named ports. The first cut worked around that by capturing the WHOLE
 * device unpositioned (linked port-for-port) and matrixing the range out —
 * which on an X32 turned every stereo module into a 32-port stream: 288
 * daemon links, ~2 MB of PipeWire scratch per port, 30 MB per runner.
 *
 * This helper does what WirePlumber cannot: the stream is created exactly as
 * wide as the module's range with `node.autoconnect=false`, and its ports are
 * linked to the device ports by CHANNEL INDEX. Ports are read from `pw-dump`
 * because `port.id` (the channel index) is only there — `pw-link` object ids
 * are allocation order and re-shuffle on every renegotiation. Links are made
 * by object id, so duplicate node names cannot misroute.
 */

export interface StreamLinkSpec {
    /** `node.name` the stream was created with (`MR_PW_<instanceId>`). */
    streamNode: string;
    /** `capture`: device output ports → stream input ports. `playback`: stream output ports → device input ports. */
    direction: 'capture' | 'playback';
    /** PipeWire node name of the device. */
    deviceNode: string;
    /** 0-based index of the first device channel. */
    firstIndex: number;
    /** Stream width = stream ports to link. */
    channels: number;
    /** Capture only: the single device channel at `firstIndex` feeds every stream channel. */
    dualMono?: boolean;
}

export interface StreamLinkResult {
    /** Links made, or already present. */
    linked: number;
    /** Stream channels with no device port at their index (they carry silence). */
    missing: number;
    /** Stream ports found; 0 = the stream node never appeared. */
    streamPorts: number;
    devicePorts: number;
}

/** Test seam: `pw-dump` as parsed JSON and a port-to-port link by object id. */
export interface StreamLinkDeps {
    dump: () => Promise<unknown[]>;
    link: (outputPortId: number, inputPortId: number) => Promise<void>;
}

export interface PortEntry {
    /** `port.id` — the channel index within the node. */
    index: number;
    /** Object id, what `pw-link` is given. */
    id: number;
    name: string;
}

interface DumpObject {
    id: number;
    type: string;
    info?: { direction?: string; props?: Record<string, unknown> };
}

function isDumpObject(o: unknown): o is DumpObject {
    return typeof o === 'object' && o !== null && typeof (o as DumpObject).id === 'number';
}

/**
 * Ports of the node called `nodeName` (the NEWEST one if several — a restart
 * can briefly overlap with its predecessor), in channel order.
 */
export function portsFromDump(
    dump: unknown[],
    nodeName: string,
    direction: 'input' | 'output',
): PortEntry[] {
    const objects = dump.filter(isDumpObject);
    let node: DumpObject | null = null;
    for (const o of objects) {
        if (o.type.endsWith(':Node') && o.info?.props?.['node.name'] === nodeName) {
            if (!node || o.id > node.id) node = o;
        }
    }
    if (!node) return [];
    const nodeId = node.id;
    return objects
        .filter(
            (o) =>
                o.type.endsWith(':Port') &&
                o.info?.direction === direction &&
                Number(o.info.props?.['node.id']) === nodeId,
        )
        .map((o) => ({
            index: Number(o.info?.props?.['port.id'] ?? 0),
            id: o.id,
            name: String(o.info?.props?.['port.name'] ?? o.id),
        }))
        .sort((a, b) => a.index - b.index);
}

const defaultDeps: StreamLinkDeps = {
    dump: async () => {
        const { stdout } = await execFileAsync('pw-dump', [], {
            timeout: 5000,
            maxBuffer: 64 * 1024 * 1024,
        });
        return JSON.parse(stdout) as unknown[];
    },
    link: async (outputPortId, inputPortId) => {
        try {
            await execFileAsync('pw-link', [String(outputPortId), String(inputPortId)], {
                timeout: 5000,
            });
        } catch (err) {
            // Already linked (a re-run after PLAYING) is success, not failure.
            if (/exist/i.test(formatError(err))) return;
            throw new Error(`pw-link ${outputPortId} → ${inputPortId}: ${formatError(err)}`);
        }
    },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Link a stream's ports to the device channels of `spec`. Waits for the stream
 * node to expose its ports (it appears when the pipeline reaches PAUSED), then
 * links channel k of the stream to device channel `firstIndex + k`. Idempotent.
 */
export async function linkStreamPorts(
    spec: StreamLinkSpec,
    opts: { timeoutMs?: number; intervalMs?: number; deps?: StreamLinkDeps } = {},
): Promise<StreamLinkResult> {
    const deps = opts.deps ?? defaultDeps;
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const intervalMs = opts.intervalMs ?? 250;
    const capture = spec.direction === 'capture';
    const streamDir = capture ? 'input' : 'output';
    const deviceDir = capture ? 'output' : 'input';

    const deadline = Date.now() + timeoutMs;
    let streamPorts: PortEntry[] = [];
    let devicePorts: PortEntry[] = [];
    for (;;) {
        const dump = await deps.dump();
        streamPorts = portsFromDump(dump, spec.streamNode, streamDir);
        devicePorts = portsFromDump(dump, spec.deviceNode, deviceDir);
        if (streamPorts.length >= spec.channels || Date.now() >= deadline) break;
        await sleep(intervalMs);
    }

    const result: StreamLinkResult = {
        linked: 0,
        missing: 0,
        streamPorts: streamPorts.length,
        devicePorts: devicePorts.length,
    };
    const pairs: string[] = [];
    for (let k = 0; k < Math.min(spec.channels, streamPorts.length); k++) {
        const sp = streamPorts[k];
        const dp = devicePorts[spec.dualMono ? spec.firstIndex : spec.firstIndex + k];
        if (!dp) {
            result.missing++;
            continue;
        }
        if (capture) await deps.link(dp.id, sp.id);
        else await deps.link(sp.id, dp.id);
        result.linked++;
        pairs.push(capture ? `${dp.name}→${sp.name}` : `${sp.name}→${dp.name}`);
    }
    log.info(
        { stream: spec.streamNode, device: spec.deviceNode, pairs, ...result },
        'Stream linked to device',
    );
    return result;
}

/**
 * Per-module driver for `linkStreamPorts`: call `ensure()` after the pipeline
 * starts and on every PLAYING (a runner-internal restart re-creates the stream
 * node, so the links have to be made again). Overlapping calls collapse into
 * the run in flight.
 */
export class StreamPortLinker {
    private inFlight: Promise<void> | null = null;

    constructor(
        private readonly o: {
            /** Null = nothing to link (no pipeline, or a stream WirePlumber links itself). */
            getPlan: () => StreamLinkSpec | null;
            onResult: (result: StreamLinkResult, plan: StreamLinkSpec) => void;
            onError: (err: unknown) => void;
            /** Test seam. */
            deps?: () => StreamLinkDeps | undefined;
        },
    ) {}

    async ensure(): Promise<void> {
        if (this.inFlight) return this.inFlight;
        const plan = this.o.getPlan();
        if (!plan) return;
        this.inFlight = (async () => {
            try {
                this.o.onResult(await linkStreamPorts(plan, { deps: this.o.deps?.() }), plan);
            } catch (err) {
                this.o.onError(err);
            } finally {
                this.inFlight = null;
            }
        })();
        return this.inFlight;
    }
}
