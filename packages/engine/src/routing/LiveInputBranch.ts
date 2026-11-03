import { createLogger } from '@media-router/shared-types';
import { busEdgeSocketPath } from '../plugins/busHelpers.js';
import { waitForBusSockets } from '../child-process/busSocketGate.js';
import type { LiveInputBranch } from '../plugins/PluginModule.js';
import type { LiveInputBranchTarget } from '../child-process/UnixFdFanoutController.js';
import type { Connection } from './MediaRouter.js';
import type { ModuleInstance } from '../modules/ModuleInstance.js';

const log = createLogger('LiveInputBranch');

/** How long a live add waits on the spot for the producer's edge socket; past it the branch
 *  joins once the socket accepts, the sink running without it meanwhile. */
export const BRANCH_EDGE_WAIT_MS = 5_000;

/** True once the sink's runner has a launched pipeline to mutate. */
export function hasLaunchedPipeline(sink: ModuleInstance): boolean {
    return sink.getChildProcess?.()?.pipelineLaunchedAt !== undefined;
}

/** A producer whose gst pipeline is down or still gated: its edge socket comes with its next
 *  launch, so a live add does not wait for it on the spot. A producer without a gst child (a
 *  sidecar's fan-out) is not judged. */
export function producerAway(producer: ModuleInstance | undefined): boolean {
    const child = producer?.getChildProcess?.();
    return !!child && child.pipelineLaunchedAt === undefined;
}

/** The live-input branch of one edge on a running aggregator sink plus its
 *  RPC target; null when the sink is not one, is not launched, or has none. */
export function liveBranchFor(
    sink: ModuleInstance | undefined,
    conn: Connection,
): { branch: LiveInputBranch; target: LiveInputBranchTarget } | null {
    if (!sink?.running || !hasLaunchedPipeline(sink)) return null;
    const branch = sink.getLiveInputBranch?.(conn.sinkPortId, conn.id);
    const target = sink.getLiveInputBranchTarget?.();
    return branch && target ? { branch, target } : null;
}

/** Wait (bounded) for the producer's edge socket; false on timeout. */
async function edgeUp(udpPort: number, conn: Connection): Promise<boolean> {
    const deadline = Date.now() + BRANCH_EDGE_WAIT_MS;
    return waitForBusSockets([busEdgeSocketPath(udpPort, conn.id)], {
        shouldAbort: () => Date.now() > deadline,
    });
}

export interface LiveInputOpts {
    sink: ModuleInstance;
    conn: Connection;
    label: string;
}

/** Send the add. The sink's mark goes first, so a loss the runner reports after the add stands;
 *  it comes back if the runner refuses. */
async function addBranch(
    sink: ModuleInstance,
    live: { branch: LiveInputBranch; target: LiveInputBranchTarget },
): Promise<void> {
    const marked = sink.isLiveInputLost?.(live.branch.name) ?? false;
    sink.noteLiveInputRestored?.(live.branch.name);
    try {
        await live.target.busInputAdd(live.branch);
    } catch (err) {
        if (marked) sink.noteLiveInputAbsent?.(live.branch.name);
        throw err;
    }
    await sink.refreshPipelineDescription?.();
}

/** Add the edge's branch once its producer's edge socket accepts (B-194; one on a socket nobody
 *  serves fails in the runner): at once within `BRANCH_EDGE_WAIT_MS`, else (or `producerAway`)
 *  when it does, the sink running without it meanwhile. False = no branch, or refused. */
export async function addLiveInput(
    opts: LiveInputOpts & { udpPort: number; producerAway?: boolean },
): Promise<boolean> {
    const { sink, conn, udpPort, label } = opts;
    const live = liveBranchFor(sink, conn);
    if (!live?.branch.description) return false;
    if (opts.producerAway || !(await edgeUp(udpPort, conn))) {
        joinWhenUp({ sink, conn, udpPort, label }, live.branch.name);
        return true;
    }
    try {
        await addBranch(sink, live);
        log.info(
            { sink: conn.sinkModuleId, branch: live.branch.name },
            `Live input added ${label}`,
        );
        return true;
    } catch (err) {
        log.warn(
            { err, sink: conn.sinkModuleId, port: conn.sinkPortId },
            'Live input add failed — module restart instead',
        );
        return false;
    }
}

/** The branch waits, unbounded, for its edge socket and is added once it accepts; the
 *  producer's PLAYING (rejoin, re-link) may add it first. Gives up once the branch is no longer
 *  missing, unwired, or the sink relaunched (as the gate's wait gives up when superseded). */
function joinWhenUp(opts: LiveInputOpts & { udpPort: number }, name: string): void {
    const { sink, conn, udpPort, label } = opts;
    const launch = sink.getChildProcess?.()?.pipelineLaunchedAt;
    sink.noteLiveInputAbsent?.(name);
    log.info(
        { sink: conn.sinkModuleId, branch: name },
        `Live input ${label} waits for its producer`,
    );
    const superseded = () =>
        !sink.isLiveInputLost?.(name) ||
        sink.getChildProcess?.()?.pipelineLaunchedAt !== launch ||
        !liveBranchFor(sink, conn)?.branch.description;
    void waitForBusSockets([busEdgeSocketPath(udpPort, conn.id)], { shouldAbort: superseded })
        .then(async (up) => {
            const live = up && !superseded() ? liveBranchFor(sink, conn) : null;
            if (!live) return;
            await addBranch(sink, live);
            log.info({ sink: conn.sinkModuleId, branch: name }, `Live input added ${label}`);
        })
        .catch((err) =>
            log.warn(
                { err, sink: conn.sinkModuleId, port: conn.sinkPortId },
                `Live input add failed for ${label} — it joins when its producer plays`,
            ),
        );
}

/** Take the edge's branch off the running pipeline. False = run the classic teardown. */
export async function removeLiveInput(opts: LiveInputOpts): Promise<boolean> {
    const { sink, conn, label } = opts;
    const live = liveBranchFor(sink, conn);
    if (!live) return false;
    try {
        await live.target.busInputRemove(live.branch);
        await sink.refreshPipelineDescription?.();
        log.info(
            { sink: conn.sinkModuleId, branch: live.branch.name },
            `Live input removed ${label}`,
        );
        return true;
    } catch (err) {
        log.warn(
            { err, sink: conn.sinkModuleId, port: conn.sinkPortId },
            'Live input remove failed — module restart instead',
        );
        return false;
    }
}

/** Wait for the edge socket, add the branch (clearing its warning), store the description. */
async function joinBranch(
    opts: LiveInputOpts & { udpPort: number },
    live: { branch: LiveInputBranch; target: LiveInputBranchTarget },
): Promise<void> {
    if (!(await edgeUp(opts.udpPort, opts.conn))) throw new Error('new edge socket never appeared');
    await addBranch(opts.sink, live);
}

/** Re-link the edge's branch after its producer relaunched: drop (if still
 *  there), wait for the new edge socket, add. False = relaunch the consumer. */
export async function relinkLiveInput(opts: LiveInputOpts & { udpPort: number }): Promise<boolean> {
    const { sink, conn, label } = opts;
    const live = liveBranchFor(sink, conn);
    if (!live?.branch.description) return false;
    try {
        await live.target.busInputRemove(live.branch);
        await joinBranch(opts, live);
        log.info(
            { sink: conn.sinkModuleId, branch: live.branch.name },
            `Live input re-linked ${label}`,
        );
        return true;
    } catch (err) {
        log.warn(
            { err, sink: conn.sinkModuleId, port: conn.sinkPortId },
            'Live input re-link failed — consumer relaunch instead',
        );
        return false;
    }
}

/** Add a branch the sink runs without (left out at launch, or dropped) once its producer
 *  plays (B-192): wait for the edge socket, add. False = not added; the next PLAYING of
 *  either end tries again. */
export async function rejoinLiveInput(opts: LiveInputOpts & { udpPort: number }): Promise<boolean> {
    const { sink, conn, label } = opts;
    const live = liveBranchFor(sink, conn);
    if (!live?.branch.description) return false;
    try {
        await joinBranch(opts, live);
        log.info(
            { sink: conn.sinkModuleId, branch: live.branch.name },
            `Live input joined ${label}`,
        );
        return true;
    } catch (err) {
        log.warn(
            { err, sink: conn.sinkModuleId, port: conn.sinkPortId },
            `Live input join failed for ${label}`,
        );
        return false;
    }
}

/** Replace the edge's branch in place (a channel-map edit): the edge socket
 *  is unchanged, so no wait. False = fall back to teardown + execute. */
export async function replaceLiveInput(opts: LiveInputOpts): Promise<boolean> {
    const { sink, conn, label } = opts;
    const live = liveBranchFor(sink, conn);
    if (!live?.branch.description) return false;
    try {
        await live.target.busInputRemove(live.branch);
        await live.target.busInputAdd(live.branch);
        await sink.refreshPipelineDescription?.();
        log.info(
            { sink: conn.sinkModuleId, branch: live.branch.name },
            `Live input replaced ${label}`,
        );
        return true;
    } catch (err) {
        log.warn(
            { err, sink: conn.sinkModuleId, port: conn.sinkPortId },
            'Live input replace failed — re-execute instead',
        );
        return false;
    }
}
