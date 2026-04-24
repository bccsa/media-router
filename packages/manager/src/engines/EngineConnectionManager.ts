import { EventEmitter } from 'events';
import { Server } from '@media-router/dgram-comms';
import { createLogger } from '@media-router/shared-types';
import type { ConfigStore } from '../config/ConfigStore.js';
import { reconcileInterlocks } from '../config/reconcileInterlocks.js';

const log = createLogger('EngineConnectionManager');

/**
 * Manages engine connections via dgram-comms UDP.
 *
 * Validates connecting engines against registered credentials,
 * pushes active profile config on connect, tracks online/offline.
 *
 * Emits:
 *   - 'engineOnline' (engineId)
 *   - 'engineOffline' (engineId)
 *   - 'engineState' (engineId, state)
 */
export class EngineConnectionManager extends EventEmitter {
    private server: Server;
    private configStore: ConfigStore;
    private onlineEngines = new Set<string>();
    /** Map: clientId (engineId) → dgram-comms Socket instance */
    private engineSockets = new Map<string, unknown>();

    constructor(configStore: ConfigStore, port = 3000) {
        super();

        this.configStore = configStore;
        this.server = new Server({
            port,
            encryptionKeys: this.buildEncryptionKeys(),
            connectionTimeout: 2000,
            missedKeepaliveThreshold: 2,
        });

        this.server.on('connection', (socket: any, clientId: string) => {
            log.info({ engineId: clientId }, 'engine connected');
            this.onlineEngines.add(clientId);
            this.engineSockets.set(clientId, socket);

            // Push active profile config to engine
            const engine = this.configStore.getEngine(clientId);
            if (engine?.active_profile) {
                const profileName = engine.active_profile as string;
                // Reconcile interlocks BEFORE sending so the engine never starts
                // with two members of a group hot at once.
                let repairOps: ReturnType<typeof reconcileInterlocks> = [];
                const config = this.configStore.modifyProfileConfig(
                    clientId,
                    profileName,
                    (cfg) => {
                        repairOps = reconcileInterlocks(cfg);
                        return cfg;
                    },
                );
                if (config) {
                    if (repairOps.length > 0) {
                        log.info(
                            { engineId: clientId, opCount: repairOps.length },
                            'Repaired interlocks on connect',
                        );
                        this.emit('interlockRepair', clientId, repairOps);
                    }
                    socket.send('config', config, { guaranteeDelivery: true });
                }
            }

            this.emit('engineOnline', clientId);

            // Forward engine state updates to manager
            socket.on('state', (state: unknown) => {
                this.emit('engineState', clientId, state);
            });

            socket.on('vu', (data: unknown) => {
                this.emit('engineVu', clientId, data);
            });

            socket.on('system', (data: unknown) => {
                this.emit('engineSystem', clientId, data);
            });

            socket.on('logs', (data: unknown) => {
                this.emit('engineLogs', clientId, data);
            });

            // Generic device-list forward. Engine sends `deviceList` with a
            // `type` discriminator (e.g. 'audio-source', 'video', 'drm-connector');
            // the forwarder caches per type and broadcasts to subscribed browsers.
            socket.on('deviceList', (data: unknown) => {
                this.emit('engineDeviceList', clientId, data);
            });

            // LCP engine start/stop (forward running state to browsers)
            socket.on('lcpEngineCommand', (data: unknown) => {
                this.emit('engineLcpCommand', clientId, data);
            });

            // Engine reports its running state on connect
            socket.on('engineRunningState', (data: unknown) => {
                this.emit('engineRunningState', clientId, data);
            });

            // Unified patch from engine (N-1 router)
            socket.on('patch', (data: unknown) => {
                this.emit('enginePatch', clientId, data);
            });

            // Socket-level disconnect is handled by server.on('disconnection') below
        });

        this.server.on('disconnection', (clientId: string) => {
            log.info({ engineId: clientId }, 'engine disconnected');
            this.onlineEngines.delete(clientId);
            this.engineSockets.delete(clientId);
            this.emit('engineOffline', clientId);
        });
    }

    /** Start listening for engine connections. */
    async start(): Promise<void> {
        await this.server.start();
    }

    /** Stop the server. */
    async stop(): Promise<void> {
        await this.server.stop();
        this.onlineEngines.clear();
        this.engineSockets.clear();
    }

    /** Send a message to a specific engine. */
    sendToEngine(
        engineId: string,
        topic: string,
        message: unknown,
        options?: { guaranteeDelivery?: boolean },
    ): void {
        this.server.sendTo(engineId, topic, message, options);
    }

    /** Check if an engine is currently connected. */
    isEngineOnline(engineId: string): boolean {
        return this.onlineEngines.has(engineId);
    }

    /** Rebuild encryption keys from ConfigStore (call when passwords change). */
    refreshEncryptionKeys(): void {
        this.server.refreshEncryptionKeys(this.buildEncryptionKeys());
    }

    private buildEncryptionKeys(): Record<string, string> {
        const keys: Record<string, string> = {};
        for (const engine of this.configStore.getAllEngines()) {
            keys[engine.engine_id as string] = engine.password as string;
        }
        return keys;
    }
}
