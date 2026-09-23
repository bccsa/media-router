import { EventEmitter } from 'events';
import { Server, type ListenerSpec } from '@media-router/dgram-comms';
import { createLogger } from '@media-router/shared-types';
import type { EnginePath } from '@media-router/shared-types';
import type { ConfigStore } from '../config/ConfigStore.js';
import { reconcileInterlocks } from '../config/reconcileInterlocks.js';

const log = createLogger('EngineConnectionManager');

/** Engine→manager topics forwarded 1:1 as `engine<Topic>` events. */
const FORWARDED_TOPICS: Array<[topic: string, event: string]> = [
    ['state', 'engineState'],
    ['vu', 'engineVu'],
    ['system', 'engineSystem'],
    // Engine advertises its effective per-plugin config schemas on connect —
    // this host's real capabilities (issue #661).
    ['capabilities', 'engineCapabilities'],
    ['logs', 'engineLogs'],
    // Generic device-list forward: `deviceList` carries a `type` discriminator
    // (e.g. 'audio-source', 'video', 'drm-connector'); the forwarder caches per
    // type and broadcasts to subscribed browsers.
    ['deviceList', 'engineDeviceList'],
    // LCP engine start/stop (forward running state to browsers)
    ['lcpEngineCommand', 'engineLcpCommand'],
    // Engine reports its running state on connect
    ['engineRunningState', 'engineRunningState'],
    // Unified patch from engine (N-1 router)
    ['patch', 'enginePatch'],
    // Host reboot failed (typically a polkit denial) — relayed so the
    // dashboard can surface the failure instead of silently swallowing it.
    ['rebootFailed', 'engineRebootFailed'],
];

/**
 * Manages engine connections via dgram-comms UDP.
 *
 * Validates connecting engines against registered credentials,
 * pushes active profile config on connect, tracks online/offline.
 * Listens on one or more UDP ports (issue #692) and can rebind live.
 *
 * Emits:
 *   - 'engineOnline' (engineId)
 *   - 'engineOffline' (engineId)
 *   - 'engineState' (engineId, state)
 *   - 'engineCapabilities' (engineId, pluginSchemas)
 *   - 'enginePathUp' / 'enginePathDown' (engineId, endpoint)
 */
export class EngineConnectionManager extends EventEmitter {
    private server: Server;
    private configStore: ConfigStore;
    private onlineEngines = new Set<string>();
    /** Map: clientId (engineId) → dgram-comms Socket instance */
    private engineSockets = new Map<string, unknown>();
    private _listeners: ListenerSpec[];
    private started = false;

    constructor(configStore: ConfigStore, listeners: number | ListenerSpec[] = 3000) {
        super();
        this.configStore = configStore;
        this._listeners = typeof listeners === 'number' ? [{ port: listeners }] : listeners;
        this.server = this.buildServer(this._listeners);
    }

    /** The UDP listeners engines can currently connect on. */
    get dgramListeners(): ListenerSpec[] {
        return this._listeners.map((l) => ({ ...l }));
    }

    private buildServer(listeners: ListenerSpec[]): Server {
        const server = new Server({
            listeners,
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

        server.on('connection', (socket: any, clientId: string) => {
            log.info({ engineId: clientId }, 'engine connected');
            this.onlineEngines.add(clientId);
            this.engineSockets.set(clientId, socket);
            this.pushActiveConfig(clientId, socket);
            this.emit('engineOnline', clientId);
            for (const [topic, event] of FORWARDED_TOPICS) {
                socket.on(topic, (data: unknown) => this.emit(event, clientId, data));
            }
            // Socket-level disconnect is handled by server.on('disconnection') below
        });

        server.on('disconnection', (clientId: string) => {
            log.info({ engineId: clientId }, 'engine disconnected');
            this.onlineEngines.delete(clientId);
            this.engineSockets.delete(clientId);
            this.emit('engineOffline', clientId);
        });

        server.on('pathUp', (clientId: string, endpoint: string) => {
            log.info({ engineId: clientId, endpoint }, 'engine path up');
            this.emit('enginePathUp', clientId, endpoint);
        });
        server.on('pathDown', (clientId: string, endpoint: string) => {
            log.warn({ engineId: clientId, endpoint }, 'engine path down');
            this.emit('enginePathDown', clientId, endpoint);
        });

        return server;
    }

    /** Push the active profile to a freshly connected engine, interlocks reconciled first. */
    private pushActiveConfig(clientId: string, socket: any): void {
        const engine = this.configStore.getEngine(clientId);
        if (!engine?.active_profile) return;
        const profileName = engine.active_profile as string;
        // Reconcile interlocks BEFORE sending so the engine never starts
        // with two members of a group hot at once.
        let repairOps: ReturnType<typeof reconcileInterlocks> = [];
        const config = this.configStore.modifyProfileConfig(clientId, profileName, (cfg) => {
            repairOps = reconcileInterlocks(cfg);
            return cfg;
        });
        if (!config) return;
        if (repairOps.length > 0) {
            log.info(
                { engineId: clientId, opCount: repairOps.length },
                'Repaired interlocks on connect',
            );
            this.emit('interlockRepair', clientId, repairOps);
        }
        socket.send('config', config, { guaranteeDelivery: true });
    }

    /** Start listening for engine connections. */
    async start(): Promise<void> {
        await this.server.start();
        this.started = true;
    }

    /** Stop the server. */
    async stop(): Promise<void> {
        this.started = false;
        await this.server.stop();
        this.onlineEngines.clear();
        this.engineSockets.clear();
    }

    /**
     * Rebind to a new listener set while running. Every engine drops for
     * ~1 RTT: its next packet on the old socketID draws a `reset` from the
     * new server and it re-handshakes immediately. Listeners we do not hold
     * yet are probe-bound FIRST, so a port in use elsewhere is rejected while
     * the live server is still up. Should the real bind still fail, the old
     * set is restored; if even that fails the error names both causes and
     * `started` is false — the operator must restart the manager.
     */
    async setListeners(listeners: ListenerSpec[]): Promise<void> {
        const previous = this._listeners;
        const wasStarted = this.started;
        if (wasStarted) {
            const held = new Set(previous.map((l) => `${l.bindAddress ?? '0.0.0.0'}:${l.port}`));
            for (const spec of listeners) {
                if (!held.has(`${spec.bindAddress ?? '0.0.0.0'}:${spec.port}`)) {
                    await Server.canBind(spec);
                }
            }
            await this.stop();
        }
        const next = this.buildServer(listeners);
        try {
            if (wasStarted) await next.start();
        } catch (err) {
            this.server = this.buildServer(previous);
            this.started = false;
            log.error({ err, listeners }, 'Listener rebind failed — restoring previous listeners');
            if (wasStarted) {
                try {
                    await this.server.start();
                    this.started = true;
                } catch (rollbackErr) {
                    log.error(
                        { err: rollbackErr, listeners: previous },
                        'Rollback bind failed — manager is NOT listening for engines; restart it',
                    );
                    throw new Error(
                        `${(err as Error).message}; rollback failed: ${(rollbackErr as Error).message}`,
                    );
                }
            }
            throw err;
        }
        this.server = next;
        this._listeners = listeners.map((l) => ({ ...l }));
        this.started = wasStarted;
        log.info({ listeners }, 'Listeners rebound');
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

    /** Live paths of an online engine: its source endpoint and the listener port it uses. */
    enginePaths(engineId: string): EnginePath[] {
        return this.server.clientEndpointInfo(engineId).map((e) => ({
            remote: `${e.address}:${e.port}`,
            listenerPort: e.localPort,
        }));
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
