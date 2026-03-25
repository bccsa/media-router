import { createLogger } from '@media-router/shared-types';
import type { LcpServer } from './LcpServer.js';
import type { ManagerConnection } from './ManagerConnection.js';
import type { ModuleManager } from '../modules/ModuleManager.js';
import type { CommandDispatcher } from '../commands/CommandDispatcher.js';

const log = createLogger('LcpControlHandler');

interface LcpControlDeps {
    lcpServer: LcpServer;
    managerConnection: ManagerConnection;
    moduleManager: ModuleManager;
    commandDispatcher: CommandDispatcher;
}

/**
 * Handles control commands from the Local Control Panel (LCP).
 *
 * Pattern for each command:
 *   1. Apply locally (engine — instant)
 *   2. Broadcast to other LCP clients (skip sender)
 *   3. Forward to manager (debounced — persist + browser sync)
 */
export class LcpControlHandler {
    private deps: LcpControlDeps;
    /** Debounce timers for config forwards to manager (100ms per module). */
    private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

    /** Config action handlers: action → handler(moduleId, data, senderSocketId). */
    private configActions: Record<string, (moduleId: string, data: Record<string, unknown>, senderSocketId?: string) => void>;

    constructor(deps: LcpControlDeps) {
        this.deps = deps;

        // Register config actions (volume, mute, etc.)
        this.configActions = {
            volume: (moduleId, data, sender) => {
                this.applyAndBroadcast(moduleId, { volume: data.volume as number }, sender);
            },
            mute: (moduleId, data, sender) => {
                this.applyAndBroadcast(moduleId, { audioEnabled: !(data.muted as boolean) }, sender);
            },
        };

        this.wire();
    }

    /** Wire up the LcpServer control event. */
    private wire(): void {
        this.deps.lcpServer.on('control', (command: unknown) => {
            this.dispatch(command as Record<string, unknown>);
        });
    }

    /** Route a control command to the appropriate handler. */
    private dispatch(cmd: Record<string, unknown>): void {
        const action = cmd.action as string;
        const moduleId = cmd.moduleId as string;
        const senderSocketId = cmd._socketId as string | undefined;

        // Config actions (volume, mute, etc.)
        const configHandler = this.configActions[action];
        if (configHandler && moduleId) {
            configHandler(moduleId, cmd, senderSocketId);
            return;
        }

        // Engine lifecycle commands
        if (action === 'start') {
            this.deps.commandDispatcher.dispatch({ command: 'start' });
            this.deps.managerConnection.send('lcpEngineCommand', { command: 'start' });
            return;
        }
        if (action === 'stop') {
            this.deps.commandDispatcher.dispatch({ command: 'stop' });
            this.deps.managerConnection.send('lcpEngineCommand', { command: 'stop' });
            return;
        }

        // Unknown — forward to manager
        this.deps.managerConnection.send('control', cmd);
    }

    /**
     * Generic config change handler:
     *   1. Apply to module (GStreamer/PipeWire)
     *   2. Broadcast JSON Patch to other LCP clients (skip sender)
     *   3. Debounced forward to manager for persistence + browser sync
     */
    private applyAndBroadcast(
        moduleId: string,
        changes: Record<string, unknown>,
        senderSocketId?: string,
    ): void {
        // 1. Apply locally
        this.deps.moduleManager.applyConfigUpdate(moduleId, changes)
            .catch((err) => log.warn({ err, moduleId }, 'Config update failed'));

        // 2. Broadcast to other LCP clients
        const patch = Object.entries(changes).map(([key, value]) => ({
            op: 'replace' as const,
            path: `/modules/${moduleId}/settings/${key}`,
            value,
        }));
        if (senderSocketId) {
            this.deps.lcpServer.broadcastConfigUpdateExcept(senderSocketId, patch);
        } else {
            this.deps.lcpServer.broadcastConfigUpdate(patch);
        }

        // 3. Debounced forward to manager
        this.debouncedSendToManager(moduleId, changes);
    }

    /** Debounced forward to manager (100ms per module). */
    private debouncedSendToManager(moduleId: string, changes: Record<string, unknown>): void {
        const key = `lcpConfig:${moduleId}`;
        const existing = this.debounceTimers.get(key);
        if (existing) clearTimeout(existing);
        this.debounceTimers.set(key, setTimeout(() => {
            this.debounceTimers.delete(key);
            this.deps.managerConnection.send('lcpConfig', { moduleId, changes });
        }, 100));
    }

    /** Clean up timers. */
    destroy(): void {
        for (const timer of this.debounceTimers.values()) clearTimeout(timer);
        this.debounceTimers.clear();
    }
}
