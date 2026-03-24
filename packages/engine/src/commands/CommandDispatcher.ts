import type { ChannelMapEntry } from '@media-router/shared-types';
import { createLogger } from '@media-router/shared-types';
import type { ModuleManager } from '../modules/ModuleManager.js';
import type { MediaRouter } from '../routing/MediaRouter.js';
import type { LcpServer } from '../comms/LcpServer.js';

const log = createLogger('CommandDispatcher');

export interface CommandContext {
    moduleManager: ModuleManager;
    mediaRouter: MediaRouter;
    lcpServer: LcpServer;
    startModules: () => Promise<void>;
    stopModules: () => Promise<void>;
    resetEngine: () => Promise<void>;
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

    constructor(private ctx: CommandContext) {}

    dispatch(cmd: Record<string, unknown>): void {
        log.info({ command: cmd.command }, 'Received command');
        switch (cmd.command) {
            case 'start':
                this.commandLock = this.commandLock
                    .then(() => this.ctx.startModules())
                    .catch((err) => log.error({ err }, 'Start failed'));
                break;

            case 'stop':
                this.commandLock = this.commandLock
                    .then(() => this.ctx.stopModules())
                    .catch((err) => log.error({ err }, 'Stop failed'));
                break;

            case 'reset':
                this.commandLock = this.commandLock
                    .then(() => this.ctx.resetEngine())
                    .catch((err) => log.error({ err }, 'Reset failed'));
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
                this.ctx.moduleManager.applyConfigUpdate(moduleId, changes)
                    .then(() => {
                        log.debug({ moduleId }, 'moduleConfig: applied');
                        for (const [key, value] of Object.entries(changes)) {
                            this.ctx.lcpServer.broadcastConfigUpdate([
                                { op: 'replace', path: `/modules/${moduleId}/settings/${key}`, value },
                            ]);
                        }
                    })
                    .catch((err) => log.error({ err: err instanceof Error ? err.message : err, moduleId }, 'Config update failed'));
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
                if (!this.ctx.moduleManager.get(moduleId)) {
                    log.warn({ moduleId }, 'moduleRestart: module not running');
                    break;
                }
                this.commandLock = this.commandLock
                    .then(() => this.ctx.restartModule(moduleId))
                    .catch((err) => log.error({ err, moduleId }, 'Module restart failed'));
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
                this.commandLock = this.commandLock
                    .then(() => this.ctx.startSingleModule(moduleId))
                    .catch((err) => log.error({ err, moduleId }, 'Module start failed'));
                break;
            }

            case 'routingConnect': {
                const { sourceModuleId, sourcePortId, sinkModuleId, sinkPortId, channelMap } = cmd as {
                    sourceModuleId: string; sourcePortId: string;
                    sinkModuleId: string; sinkPortId: string;
                    channelMap?: ChannelMapEntry[];
                };
                this.ctx.mediaRouter.createConnection(sourceModuleId, sourcePortId, sinkModuleId, sinkPortId, channelMap)
                    .then((connId) => {
                        log.info({ connectionId: connId }, 'Live connect');
                        this.ctx.lcpServer.broadcastConfigUpdate([
                            { op: 'add', path: '/connections/-', value: { id: connId, sourceModuleId, sourcePortId, sinkModuleId, sinkPortId } },
                        ]);
                    })
                    .catch((err) => log.error({ err }, 'Live connect failed'));
                break;
            }

            case 'routingUpdate': {
                const { connectionId, channelMap } = cmd as { connectionId: string; channelMap?: ChannelMapEntry[] };
                log.info({ connectionId, hasChannelMap: !!channelMap?.length }, 'Routing update');
                this.ctx.mediaRouter.updateChannelMap(connectionId, channelMap)
                    .catch((err) => log.error({ err, connectionId }, 'Routing update failed'));
                break;
            }

            case 'routingDisconnect': {
                const connectionId = cmd.connectionId as string;
                this.ctx.mediaRouter.removeConnection(connectionId)
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
