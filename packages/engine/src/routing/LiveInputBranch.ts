import { createLogger } from '@media-router/shared-types';
import { busEdgeSocketPath } from '../plugins/busHelpers.js';
import { waitForBusSockets } from '../child-process/busSocketGate.js';
import type { LiveInputBranch } from '../plugins/PluginModule.js';
import type { LiveInputBranchTarget } from '../child-process/UnixFdFanoutController.js';
import type { Connection } from './MediaRouter.js';
import type { ModuleInstance } from '../modules/ModuleInstance.js';

const log = createLogger('LiveInputBranch');

/** How long a live add waits for the producer's edge socket before adding
 *  the branch anyway (the runner then contains the dead socket). */
export const BRANCH_EDGE_WAIT_MS = 5_000;

/** True once the sink's runner has a launched pipeline to mutate. */
export function hasLaunchedPipeline(sink: ModuleInstance): boolean {
    return sink.getChildProcess?.()?.pipelineLaunchedAt !== undefined;
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

/** Add the edge's branch to the running pipeline. A late producer socket
 *  still gets the branch: the runner drops it (`input_branch_lost`) and the
 *  producer's PLAYING re-links it. False = no branch, or the runner refused. */
export async function addLiveInput(opts: LiveInputOpts & { udpPort: number }): Promise<boolean> {
    const { sink, conn, udpPort, label } = opts;
    const live = liveBranchFor(sink, conn);
    if (!live?.branch.description) return false;
    try {
        if (!(await edgeUp(udpPort, conn))) {
            log.warn(
                { sink: conn.sinkModuleId, port: conn.sinkPortId },
                `Edge socket late for ${label} — adding the branch anyway`,
            );
        }
        await live.target.busInputAdd(live.branch);
        await sink.refreshPipelineDescription?.();
        sink.noteLiveInputRestored?.(live.branch.name);
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

/** Re-link the edge's branch after its producer relaunched: drop (if still
 *  there), wait for the new edge socket, add. False = relaunch the consumer. */
export async function relinkLiveInput(opts: LiveInputOpts & { udpPort: number }): Promise<boolean> {
    const { sink, conn, udpPort, label } = opts;
    const live = liveBranchFor(sink, conn);
    if (!live?.branch.description) return false;
    try {
        await live.target.busInputRemove(live.branch);
        if (!(await edgeUp(udpPort, conn))) throw new Error('new edge socket never appeared');
        await live.target.busInputAdd(live.branch);
        await sink.refreshPipelineDescription?.();
        sink.noteLiveInputRestored?.(live.branch.name);
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
