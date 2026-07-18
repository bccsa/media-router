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
 *   - 'engineCapabilities' (engineId, pluginSchemas)
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
            // Load-bearing asymmetry: the server must be the PATIENT side.
            // The engine client (ManagerConnection: 3000/3, ~4.5-5.25s) must
            // detect a dead link first and re-handshake — its retry carries
            // the same session nonce, so we re-ack the same socketID and a
            // short WAN loss burst never tears the session down. Inverting
            // this (server faster) makes the server forget the socketID and
            // silently drop the engine's packets for seconds per burst — the
            // gate01 flap incident of 2026-07-18.
            connectionTimeout: 5000,
            missedKeepaliveThreshold: 3,
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

            // Engine advertises its effective per-plugin config schemas on
            // connect — this host's real capabilities (issue #661).
            socket.on('capabilities', (data: unknown) => {
                this.emit('engineCapabilities', clientId, data);
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

            // Host reboot failed (typically a polkit denial) — relayed so the
            // dashboard can surface the failure instead of silently swallowing it.
            socket.on('rebootFailed', (data: unknown) => {
                this.emit('engineRebootFailed', clientId, data);
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

    /**
     * Close out any live session under `oldId` after an engine_id rename.
     *
     * The engine doesn't know about the rename — it still authenticates as
     * `oldId` from its local `profile.name`. Two reasons we can't just
     * leave the existing socket running:
     *
     *  1. **Operator UX.** The engine *isn't* online under `newId` until
     *     they update `profile.name` on the engine host and restart the
     *     service. If we moved the socket from `oldId` to `newId` to keep
     *     `isEngineOnline(newId)` truthy, the detail view would lie about
     *     reachability and the operator would have no signal that they
     *     still need to act on the engine side.
     *  2. **Orphan events.** Each `Socket` captures its `encryptionKey` at
     *     `handleConnect` and the Server's per-packet decryption rejects
     *     messages from removed keys (see `Server.handleMessage`) — so
     *     `engineState` / `engineLogs` listeners stop firing once
     *     `refreshEncryptionKeys` runs. But keepalive packets are
     *     unencrypted, so the session would stay technically alive
     *     forever. Destroying the socket closes that loose end.
     *
     * Net result: rename → engine flips offline immediately, operator
     * updates `profile.name` + restarts engine → engine reconnects as
     * `newId` through the normal onboarding path. Historical state
     * (cached states, logs, devices, VU) is preserved across the gap by
     * `EngineEventForwarder.notifyRename` so the detail view doesn't
     * blank out while the operator is verifying the rename took effect.
     */
    notifyRename(oldId: string, newId: string): void {
        if (oldId === newId) return;
        this.onlineEngines.delete(oldId);
        const socket = this.engineSockets.get(oldId);
        if (socket !== undefined) {
            this.engineSockets.delete(oldId);
            // `Socket.destroy()` fires the Server's `onDisconnect` →
            // `disconnection(oldId)` event, which routes through the
            // existing offline handler. We've already removed oldId from
            // the local caches above, so that handler's deletes are
            // no-ops and the engine:offline broadcast lands on a key the
            // browser has already let go of — harmless.
            (socket as { destroy?: () => void }).destroy?.();
        }
    }

    private buildEncryptionKeys(): Record<string, string> {
        const keys: Record<string, string> = {};
        for (const engine of this.configStore.getAllEngines()) {
            keys[engine.engine_id as string] = engine.password as string;
        }
        return keys;
    }
}
