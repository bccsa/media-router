import type { ChannelMapEntry, PatchOp } from '@media-router/shared-types';
import { createLogger } from '@media-router/shared-types';
import type { ModuleManager } from '../modules/ModuleManager.js';
import type { MediaRouter } from '../routing/MediaRouter.js';
import type { LcpServer } from '../comms/LcpServer.js';

const log = createLogger('CommandDispatcher');

export interface CommandContext {
    moduleManager: ModuleManager;
    mediaRouter: MediaRouter;
    lcpServer: LcpServer;
    currentConfig: Record<string, unknown> | null;
    /** Engine-level run intent (ModuleRunController.isRunning). Gates single-module starts. */
    isEngineRunning: () => boolean;
    /**
     * Echo the target run state to the LCP the moment a lifecycle command is
     * accepted. The run flag itself flips at execution (ModuleRunController),
     * but execution queues behind commandLock — a stop dispatched during a
     * start's pipeline bring-up (~16s of connection application + bus-consumer
     * restarts) would otherwise sit invisible until the lock frees, while the
     * manager showed the new state instantly. The execution-time broadcast
     * still follows and agrees (or corrects, on a failed startAll).
     */
    broadcastRunIntent: (running: boolean) => void;
    startModules: () => Promise<void>;
    stopModules: () => Promise<void>;
    resetEngine: () => Promise<void>;
    rebootHost: () => Promise<void>;
    restartModule: (moduleId: string) => Promise<void>;
    startSingleModule: (moduleId: string) => Promise<void>;
    deleteSingleModule: (moduleId: string) => Promise<void>;
    disableModule: (moduleId: string) => Promise<void>;
    enableModule: (moduleId: string) => Promise<void>;
}

/**
 * Dispatches commands received from the manager to the appropriate handler.
 * Serializes start/stop through a command lock to prevent overlapping.
 */
export class CommandDispatcher {
    private commandLock: Promise<void> = Promise.resolve();
    /** Pending lifecycle command — only the last one is kept (queue depth = 1). */
    private pendingLifecycle: 'start' | 'stop' | 'reset' | null = null;
    private lifecycleBusy = false;

    constructor(private ctx: CommandContext) {}

    /** Check if a stop is pending or currently executing (used by resetEngine to abort restart). */
    get isStopRequested(): boolean {
        return this.pendingLifecycle === 'stop';
    }

    private scheduleLifecycle(command: 'start' | 'stop' | 'reset'): void {
        // Reset keeps the current intent — it's a stop+start, not a state change.
        if (command !== 'reset') {
            this.ctx.broadcastRunIntent(command === 'start');
        }
        if (this.lifecycleBusy) {
            log.info(
                { command, replaced: this.pendingLifecycle },
                'Lifecycle busy — replacing pending command',
            );
            this.pendingLifecycle = command;
            return;
        }

        this.runLifecycle(command);
    }

    private runLifecycle(command: 'start' | 'stop' | 'reset'): void {
        this.lifecycleBusy = true;
        this.pendingLifecycle = null;

        this.commandLock = this.commandLock
            .then(() => {
                return command === 'start'
                    ? this.ctx.startModules()
                    : command === 'stop'
                      ? this.ctx.stopModules()
                      : this.ctx.resetEngine();
            })
            .catch((err) => log.error({ err, command }, 'Lifecycle command failed'))
            .finally(() => {
                this.lifecycleBusy = false;
                if (this.pendingLifecycle) {
                    const next = this.pendingLifecycle;
                    // Check if any module is actually running — not just existing in the map.
                    // After stopAll(), modules exist but are stopped (size > 0, running = 0).
                    const states = this.ctx.moduleManager.getAllStates();
                    const anyRunning = Object.values(states).some((s) => s.running);
                    // Skip if the engine is already in the desired state
                    if ((next === 'start' && anyRunning) || (next === 'stop' && !anyRunning)) {
                        log.info(
                            { command: next, anyRunning },
                            'Skipping pending — already in desired state',
                        );
                        this.pendingLifecycle = null;
                        return;
                    }
                    log.info({ command: next }, 'Running pending lifecycle command');
                    this.runLifecycle(next);
                }
            });
    }

    dispatch(cmd: Record<string, unknown>): void {
        log.info({ command: cmd.command }, 'Received command');
        switch (cmd.command) {
            case 'start':
                this.scheduleLifecycle('start');
                break;

            case 'stop':
                this.scheduleLifecycle('stop');
                break;

            case 'reset':
                this.scheduleLifecycle('reset');
                break;

            case 'reboot':
                // Host reboot — fire-and-forget. The system goes down with
                // the engine process, so there's nothing meaningful to await
                // here; just log if the systemctl call rejects (typically a
                // polkit permission error the operator needs to fix).
                this.ctx
                    .rebootHost()
                    .catch((err) => log.error({ err }, 'Host reboot failed'));
                break;

            case 'moduleConfig': {
                const moduleId = cmd.moduleId as string;
                const changes = cmd.changes as Record<string, unknown>;
                log.debug({ moduleId, keys: Object.keys(changes) }, 'moduleConfig: processing');
                if (!this.ctx.moduleManager.get(moduleId)) {
                    log.warn({ moduleId }, 'moduleConfig: module not running');
                    break;
                }
                // Config updates run outside commandLock — they shouldn't block start/stop
                this.ctx.moduleManager
                    .applyConfigUpdate(moduleId, changes)
                    .then(() => {
                        log.debug({ moduleId }, 'moduleConfig: applied');
                        for (const [key, value] of Object.entries(changes)) {
                            this.ctx.lcpServer.broadcastConfigUpdate([
                                {
                                    op: 'replace',
                                    path: `/modules/${moduleId}/settings/${key}`,
                                    value,
                                },
                            ]);
                        }
                    })
                    .catch((err) =>
                        log.error(
                            { err: err instanceof Error ? err.message : err, moduleId },
                            'Config update failed',
                        ),
                    );
                break;
            }

            case 'moduleDisable': {
                const moduleId = cmd.moduleId as string;
                this.commandLock = this.commandLock
                    .then(async () => {
                        await this.ctx.disableModule(moduleId);
                        this.ctx.lcpServer.broadcastConfigUpdate([
                            { op: 'replace', path: `/modules/${moduleId}/enabled`, value: false },
                        ]);
                    })
                    .catch((err) => log.error({ err, moduleId }, 'Module disable failed'));
                break;
            }

            case 'moduleEnable': {
                const moduleId = cmd.moduleId as string;
                this.commandLock = this.commandLock
                    .then(async () => {
                        await this.ctx.enableModule(moduleId);
                        this.ctx.lcpServer.broadcastConfigUpdate([
                            { op: 'replace', path: `/modules/${moduleId}/enabled`, value: true },
                        ]);
                    })
                    .catch((err) => log.error({ err, moduleId }, 'Module enable failed'));
                break;
            }

            case 'moduleRestart': {
                const moduleId = cmd.moduleId as string;
                const instance = this.ctx.moduleManager.get(moduleId);
                if (instance?.running) {
                    // Module is running — restart it (stop + start + reapply connections)
                    this.commandLock = this.commandLock
                        .then(() => this.ctx.restartModule(moduleId))
                        .catch((err) => log.error({ err, moduleId }, 'Module restart failed'));
                } else if (this.ctx.isEngineRunning()) {
                    // Module exists but failed to start — try starting it fresh.
                    // Only when the engine itself is running: after a stop, dormant
                    // instances linger in the map with running=false, and starting
                    // one would spawn a live pipeline on a stopped engine (broadcast
                    // hazard). The run intent is the gate — see ModuleRunController.
                    log.info({ moduleId }, 'moduleRestart: module not running — attempting start');
                    this.commandLock = this.commandLock
                        .then(() => this.ctx.startSingleModule(moduleId))
                        .catch((err) => log.error({ err, moduleId }, 'Module start failed'));
                } else {
                    log.info(
                        { moduleId },
                        'moduleRestart: engine stopped — refusing to start a single module',
                    );
                }
                break;
            }

            case 'moduleDelete': {
                const moduleId = cmd.moduleId as string;
                this.commandLock = this.commandLock
                    .then(() => this.ctx.deleteSingleModule(moduleId))
                    .catch((err) => log.error({ err, moduleId }, 'Module delete failed'));
                break;
            }

            case 'moduleStart': {
                const moduleId = cmd.moduleId as string;
                if (this.ctx.moduleManager.get(moduleId)) {
                    log.warn({ moduleId }, 'moduleStart: module already running');
                    break;
                }
                // Same broadcast hazard as moduleRestart: a module added while
                // stopped is never created (EnginePatchRouter skips auto-start),
                // so get() is undefined here — without this gate it would spawn a
                // live pipeline on a stopped engine. Run intent is the gate.
                if (!this.ctx.isEngineRunning()) {
                    log.info(
                        { moduleId },
                        'moduleStart: engine stopped — refusing to start a single module',
                    );
                    break;
                }
                this.commandLock = this.commandLock
                    .then(() => this.ctx.startSingleModule(moduleId))
                    .catch((err) => log.error({ err, moduleId }, 'Module start failed'));
                break;
            }

            case 'routingConnect': {
                const { sourceModuleId, sourcePortId, sinkModuleId, sinkPortId, channelMap } =
                    cmd as {
                        sourceModuleId: string;
                        sourcePortId: string;
                        sinkModuleId: string;
                        sinkPortId: string;
                        channelMap?: ChannelMapEntry[];
                    };
                this.ctx.mediaRouter
                    .createConnection(
                        sourceModuleId,
                        sourcePortId,
                        sinkModuleId,
                        sinkPortId,
                        channelMap,
                    )
                    .then((connId) => {
                        log.info({ connectionId: connId }, 'Live connect');
                        this.ctx.lcpServer.broadcastConfigUpdate([
                            {
                                op: 'add',
                                path: '/connections/-',
                                value: {
                                    id: connId,
                                    sourceModuleId,
                                    sourcePortId,
                                    sinkModuleId,
                                    sinkPortId,
                                },
                            },
                        ]);
                    })
                    .catch((err) => log.error({ err }, 'Live connect failed'));
                break;
            }

            case 'routingUpdate': {
                const { connectionId, channelMap } = cmd as {
                    connectionId: string;
                    channelMap?: ChannelMapEntry[];
                };
                log.info({ connectionId, hasChannelMap: !!channelMap?.length }, 'Routing update');
                this.ctx.mediaRouter
                    .updateChannelMap(connectionId, channelMap)
                    .catch((err) => log.error({ err, connectionId }, 'Routing update failed'));
                break;
            }

            case 'routingDisconnect': {
                const connectionId = cmd.connectionId as string;
                this.ctx.mediaRouter
                    .removeConnection(connectionId)
                    .then(() => {
                        log.info({ connectionId }, 'Live disconnect');
                        this.ctx.lcpServer.broadcastConfigUpdate([
                            { op: 'remove', path: `/connections/${connectionId}` },
                        ]);
                    })
                    .catch((err) => log.error({ err, connectionId }, 'Live disconnect failed'));
                break;
            }

            default:
                log.warn({ command: cmd.command }, 'Unknown command');
        }
    }
}
