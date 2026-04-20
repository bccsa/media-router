import { GstChildProcess } from './GstChildProcess.js';
import { createLogger } from '@media-router/shared-types';

const log = createLogger('ChildProcessManager');

/**
 * Registry of all active GStreamer child processes.
 *
 * Tracks instances by module ID, provides bulk operations
 * (kill all on shutdown), and orphan detection.
 */
export class ChildProcessManager {
    private children = new Map<string, GstChildProcess>();

    /** Register a child process for a module instance. */
    register(instanceId: string, child: GstChildProcess): void {
        // Clean up existing if any
        const existing = this.children.get(instanceId);
        if (existing) {
            existing.destroy().catch((err) => {
                log.debug({ err, instanceId }, 'Old child process cleanup failed');
            });
        }
        this.children.set(instanceId, child);
    }

    /** Unregister and destroy a child process. */
    async unregister(instanceId: string): Promise<void> {
        const child = this.children.get(instanceId);
        if (child) {
            await child.destroy();
            this.children.delete(instanceId);
        }
    }

    /** Get a child process by instance ID. */
    get(instanceId: string): GstChildProcess | undefined {
        return this.children.get(instanceId);
    }

    /** Stop and destroy all child processes. */
    async killAll(): Promise<void> {
        const promises = Array.from(this.children.values()).map((child) =>
            child.destroy().catch((err) => {
                log.error({ err }, 'Error destroying child');
            }),
        );
        await Promise.allSettled(promises);
        this.children.clear();
    }

    /** Get count of active child processes. */
    get activeCount(): number {
        return this.children.size;
    }

    /** Get PIDs of all running child processes (for orphan detection). */
    getActivePids(): number[] {
        const pids: number[] = [];
        for (const child of this.children.values()) {
            if (child.pid) pids.push(child.pid);
        }
        return pids;
    }
}
