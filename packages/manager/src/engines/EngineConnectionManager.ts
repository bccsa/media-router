import { EventEmitter } from 'events';
import { Server } from '@media-router/dgram-comms';
import { createLogger } from '@media-router/shared-types';
import type { ConfigStore } from '../config/ConfigStore.js';

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
        });

        this.server.on('connection', (socket: any, clientId: string) => {
            log.info({ engineId: clientId }, 'engine connected');
            this.onlineEngines.add(clientId);
            this.engineSockets.set(clientId, socket);

            // Push active profile config to engine
            const engine = this.configStore.getEngine(clientId);
            if (engine?.active_profile) {
                const config = this.configStore.getProfile(
                    clientId,
                    engine.active_profile as string,
                );
                if (config) {
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

            socket.on('configUpdated', (data: unknown) => {
                this.emit('engineConfigUpdated', clientId, data);
            });

            socket.on('audioDevices', (data: unknown) => {
                this.emit('engineAudioDevices', clientId, data);
            });

            // LCP config updates (persist without feedback loop)
            socket.on('lcpConfig', (data: unknown) => {
                this.emit('engineLcpConfig', clientId, data);
            });

            // LCP engine start/stop (forward running state to browsers)
            socket.on('lcpEngineCommand', (data: unknown) => {
                this.emit('engineLcpCommand', clientId, data);
            });

            // Dynamic ports update (modules with configurable port count)
            socket.on('dynamicPorts', (data: unknown) => {
                this.emit('engineDynamicPorts', clientId, data);
            });

            socket.on('disconnected', () => {
                log.info({ engineId: clientId }, 'engine disconnected');
                this.onlineEngines.delete(clientId);
                this.engineSockets.delete(clientId);
                this.emit('engineOffline', clientId);
            });
        });

        this.server.on('disconnection', (clientId: string) => {
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
