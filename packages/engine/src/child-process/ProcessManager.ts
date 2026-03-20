import { createLogger } from '@media-router/shared-types';
import { ManagedProcess, type ManagedProcessOptions } from './ManagedProcess.js';

const log = createLogger('ProcessManager');

export interface ProcessInfo {
    label: string;
    pid: number | undefined;
    running: boolean;
    uptime: number;
    exitCode: number | null;
}

/**
 * Registry of managed external processes with per-module ownership tracking.
 *
 * Plugins spawn processes via this service. When a module stops, all its
 * processes are automatically killed via `releaseAll(ownerId)`.
 */
export class ProcessManager {
    private ownership = new Map<string, Set<ManagedProcess>>();

    /** Spawn a process owned by the given module. */
    spawn(ownerId: string, options: ManagedProcessOptions): ManagedProcess {
        const proc = new ManagedProcess(options, ownerId);

        // Track ownership
        let set = this.ownership.get(ownerId);
        if (!set) {
            set = new Set();
            this.ownership.set(ownerId, set);
        }
        set.add(proc);

        // Remove from tracking when destroyed
        proc.on('stopped', () => {
            if (proc.destroyed) {
                set!.delete(proc);
                if (set!.size === 0) this.ownership.delete(ownerId);
            }
        });

        proc.start();
        log.info({ ownerId, label: options.label, command: options.command }, 'Spawned process');
        return proc;
    }

    /** Stop and remove a specific process. */
    async kill(ownerId: string, proc: ManagedProcess): Promise<void> {
        await proc.destroy();
        const set = this.ownership.get(ownerId);
        if (set) {
            set.delete(proc);
            if (set.size === 0) this.ownership.delete(ownerId);
        }
    }

    /** Kill all processes owned by a module. Called automatically on module stop. */
    async releaseAll(ownerId: string): Promise<void> {
        const set = this.ownership.get(ownerId);
        if (!set || set.size === 0) return;

        const procs = [...set];
        log.info({ ownerId, count: procs.length }, 'Releasing all processes');
        await Promise.allSettled(procs.map((p) => p.destroy()));
        this.ownership.delete(ownerId);
    }

    /** Kill every managed process (engine shutdown). */
    async killAll(): Promise<void> {
        const allProcs: ManagedProcess[] = [];
        for (const set of this.ownership.values()) {
            allProcs.push(...set);
        }
        if (allProcs.length === 0) return;

        log.info({ count: allProcs.length }, 'Killing all managed processes');
        await Promise.allSettled(allProcs.map((p) => p.destroy()));
        this.ownership.clear();
    }

    /** List processes owned by a module. */
    list(ownerId: string): ProcessInfo[] {
        const set = this.ownership.get(ownerId);
        if (!set) return [];
        return [...set].map((p) => ({
            label: p.label,
            pid: p.pid,
            running: p.isRunning,
            uptime: p.uptime,
            exitCode: p.exitCode,
        }));
    }

    /** Count of all managed processes. */
    get activeCount(): number {
        let count = 0;
        for (const set of this.ownership.values()) {
            count += set.size;
        }
        return count;
    }

    /** All PIDs (for orphan detection). */
    getActivePids(): number[] {
        const pids: number[] = [];
        for (const set of this.ownership.values()) {
            for (const p of set) {
                if (p.pid) pids.push(p.pid);
            }
        }
        return pids;
    }
}
