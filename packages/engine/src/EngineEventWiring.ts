import type { ModuleRuntimeState, PatchOp } from '@media-router/shared-types';
import { applyJsonPatch, createLogger, safeParse, PatchEnvelopeSchema } from '@media-router/shared-types';

import type { ModuleManager } from './modules/ModuleManager.js';
import type { MediaRouter } from './routing/MediaRouter.js';
import type { ManagerConnection } from './comms/ManagerConnection.js';
import { VuBatcher } from './comms/VuBatcher.js';
import { ManagerStateSync } from './comms/ManagerStateSync.js';
import { applyConfigPush } from './comms/applyConfigPush.js';
import type { LocalChanges } from './comms/LocalChanges.js';
import type { RouterTree } from './tree/RouterTree.js';
import type { LocalServer } from './comms/LocalServer.js';
import type { LcpServer } from './comms/LcpServer.js';
import type { PipeWireManager } from './audio/PipeWireManager.js';
import type { LogForwarder } from './logging/LogForwarder.js';
import type { CommandDispatcher } from './commands/CommandDispatcher.js';
import type { EnginePatchRouter } from './EnginePatchRouter.js';
import type { DeviceProviderRegistry } from './system/DeviceProviderRegistry.js';
import type { ModuleRunController } from './modules/ModuleRunController.js';

const log = createLogger('Engine');

export interface EngineEventContext {
    logForwarder: LogForwarder;
    moduleManager: ModuleManager;
    managerConnection: ManagerConnection;
    localServer: LocalServer;
    lcpServer: LcpServer;
    pipeWire: PipeWireManager;
    deviceProviders: DeviceProviderRegistry;
    commandDispatcher: CommandDispatcher;
    enginePatchRouter: EnginePatchRouter;
    runController: ModuleRunController;
    getCurrentConfig: () => Record<string, unknown> | null;
    setCurrentConfig: (config: Record<string, unknown>) => void;
    enrichConfigForLcp: (config: Record<string, unknown>) => Record<string, unknown>;
    /** Re-resolve a module's dynamic ports after a plugin auto-writes config
     *  that changes its port set (mpegts-demuxer discovery, plan Phase 3). */
    refreshModulePorts: (moduleId: string) => void;
    /** Effective per-plugin config schemas for THIS host, sent to the manager
     *  on connect so it shows this engine's real capabilities (issue #661). */
    pluginSchemas: () => Record<string, unknown>;
    /** The router's own tree (ADR-0024); null in unit tests that don't need it. */
    routerTree: RouterTree | null;
    /** On-site config and run-state changes: guaranteed upstream, journaled offline (ADR-0025). */
    localChanges: LocalChanges;
}

export function wireEngineEvents(ctx: EngineEventContext): void {
    const tree = ctx.routerTree;
    ctx.logForwarder.on('logs', (batch: unknown[]) => {
        tree?.logs(batch);
        if (ctx.managerConnection.isConnected) {
            ctx.managerConnection.send('logs', batch);
        }
    });

    // Module state to the manager (batched whole states or leaf patches) and
    // the router tree (ManagerStateSync). The LCP broadcast stays unbatched
    // and keeps the full state, vuData included.
    const states = new ManagerStateSync(ctx.managerConnection, () => ctx.moduleManager.getAllStates(), tree);
    ctx.moduleManager.on('stateChange', (instanceId: string, state: ModuleRuntimeState) => {
        ctx.lcpServer.broadcastState(instanceId, state);
        states.stateChange(instanceId, state);
    });

    ctx.moduleManager.on(
        'configUpdated',
        (instanceId: string, changes: Record<string, unknown>) => {
            log.debug({ instanceId, changes }, 'Plugin auto-detected config');
            const ops = Object.entries(changes).map(([key, value]) => ({
                op: 'replace' as const,
                path: `/modules/${instanceId}/settings/${key}`,
                value,
            }));
            // Mute state is the interlocks' (ADR-0028): through the patch router, like any write.
            if ('audioEnabled' in changes) {
                ctx.enginePatchRouter.onPatch(`plugin:${instanceId}`, 'local', ops);
                ctx.refreshModulePorts(instanceId);
                return;
            }
            // The engine's own config, the router tree and the LCP follow the
            // plugin's value too, as for dynamic ports and self-stop.
            applyJsonPatch(ctx.getCurrentConfig(), ops);
            ctx.localServer.configChanged(ops);
            ctx.localChanges.config(ops);
            // A plugin auto-write can change its dynamic port set (mpegts-
            // demuxer persisting discovered streams, plan Phase 3). Re-resolve
            // unconditionally — refreshPorts diffs the resolved list and
            // skips the patch when nothing changed, so the engine doesn't
            // need to know which plugin config keys are port-affecting.
            ctx.refreshModulePorts(instanceId);
        },
    );

    // VU: batched + deduped on its way to the manager (see VuBatcher for the
    // WAN rationale). The router tree and the LCP get each change at once —
    // they're local, not the WAN flow — but reuse the batcher's dedup verdict.
    const vuBatcher = new VuBatcher((batch) => ctx.managerConnection.send('vu', { batch }));
    ctx.moduleManager.on('vuData', (instanceId: string, data: number[]) => {
        if (vuBatcher.enqueue(instanceId, data)) {
            ctx.lcpServer.broadcastVuData(instanceId, data);
            tree?.vu(instanceId, data);
        }
    });

    // Clean up VU + state dedup maps when modules are destroyed
    ctx.moduleManager.on('moduleDeleted', (instanceId: string) => {
        vuBatcher.drop(instanceId);
        states.drop(instanceId);
        if (tree) delete tree.view.vu[instanceId];
    });

    // Config and run-intent changes reach the router tree and the LCP; a
    // writer's own ops were published to it already.
    ctx.localServer.on('local:config', (patch: PatchOp[], exceptSocketId?: string) => {
        if (tree && !(exceptSocketId && tree.bus.has(exceptSocketId))) tree.config(patch);
        const lcpOps = patch.map((op) =>
            op.path === '/' && op.op === 'replace' ? { ...op, value: ctx.enrichConfigForLcp(op.value as Record<string, unknown>) } : op,
        );
        if (exceptSocketId) ctx.lcpServer.broadcastConfigUpdateExcept(exceptSocketId, lcpOps);
        else ctx.lcpServer.broadcastConfigUpdate(lcpOps);
    });
    ctx.localServer.on('local:running', (running: boolean) => {
        tree?.info();
        ctx.lcpServer.broadcastEngineRunning(running);
    });

    ctx.managerConnection.on('config', (config: unknown) => {
        if (typeof config !== 'object' || config === null) {
            log.warn('Received invalid config from manager — expected object');
            return;
        }
        log.info('Received config from manager');
        applyConfigPush(
            {
                localChanges: ctx.localChanges,
                getConfig: ctx.getCurrentConfig,
                setConfig: ctx.setCurrentConfig,
                isRunning: () => ctx.runController.isRunning,
                applyOps: (ops) => ctx.enginePatchRouter.onPatch('manager', 'manager', ops),
                broadcastConfig: (c) => ctx.localServer.configChanged([{ op: 'replace', path: '/', value: c }]),
                restartAll: () => ctx.commandDispatcher.dispatch({ command: 'start' }),
            },
            config as Record<string, unknown>,
        );
    });

    ctx.managerConnection.on('command', (command: unknown) => {
        if (typeof command !== 'object' || command === null) {
            log.warn('Received invalid command from manager — expected object');
            return;
        }
        ctx.commandDispatcher.dispatch(command as Record<string, unknown>);
    });

    // LCP lifecycle commands (start/stop). The manager notification is
    // guaranteed: it updates the manager's persisted desired-run-state, and if
    // it's lost the 10s engineRunningState reconcile actively reverts the
    // operator's action (stop undone by an auto-start within one heartbeat).
    // During an outage it is journaled and reported in the connect handshake.
    ctx.lcpServer.on('control', (command: unknown) => {
        const cmd = command as Record<string, unknown>;
        if (cmd.action === 'start' || cmd.action === 'stop') {
            ctx.commandDispatcher.dispatch({ command: cmd.action });
            ctx.localChanges.running(cmd.action === 'start');
        }
    });

    // Handle patches from manager
    ctx.managerConnection.on('patch', (data: unknown) => {
        const envelope = safeParse(PatchEnvelopeSchema, data, 'manager:patch', log);
        if (envelope)
            ctx.enginePatchRouter.onPatch('manager', 'manager', envelope.ops as PatchOp[]);
    });

    // Patches from the LCP (validated by LcpServer; _socketId comes through)
    ctx.lcpServer.on('patch', (data: unknown) => {
        const d = data as { ops?: unknown[]; _socketId?: string };
        const envelope = safeParse(PatchEnvelopeSchema, d, 'lcp:patch', log);
        if (envelope) ctx.enginePatchRouter.onPatch(d._socketId ?? 'lcp', 'local', envelope.ops as PatchOp[]);
    });

    // Forward every registered device provider's changes to the manager
    // through a single typed topic. One loop, any number of device types.
    //
    // Best-effort ON PURPOSE: the 10s heartbeat re-broadcasts every device
    // snapshot anyway, so a dropped packet self-heals within one interval.
    // Guaranteed delivery here was measured DDoSing the NO-BR gate's lossy
    // uplink — 5 deviceLists + state + runningState per heartbeat, each
    // retransmitting up to 10x when ACKs died, ~40 packets/s of retransmit
    // flood that drowned the ACK channel and starved real commands.
    // Repetition IS the delivery guarantee for repeating telemetry.
    ctx.deviceProviders.on(
        'deviceList',
        ({ type, devices }: { type: string; devices: unknown }) => {
            tree?.devices(type, devices);
            if (!ctx.managerConnection.isConnected) return;
            ctx.managerConnection.send('deviceList', { type, devices });
        },
    );

    async function sendInitialDeviceSnapshots() {
        for (const type of ctx.deviceProviders.types()) {
            try {
                const devices = await ctx.deviceProviders.getDevices(type);
                ctx.managerConnection.send('deviceList', { type, devices });
            } catch (err) {
                log.warn({ err, type }, 'Initial device snapshot failed');
            }
        }
    }

    // Periodic full-state resync — repairs dropped per-module stateChange
    // packets (those go best-effort UDP). The snapshot covers adds/updates;
    // deletes are not visible here (they're absent from getAllStates), so
    // the manager keeps removing stale entries via guaranteed `remove`
    // patches from EnginePatchRouter.
    //
    // The heartbeat itself fragments when there are many modules — drop one
    // fragment and the whole reassembly is lost — so it's guaranteed too.
    // Without that, persistent fragmentation would stall convergence on
    // exactly the case the resync exists to repair.
    //
    // The same heartbeat re-broadcasts device snapshots. Device lists are
    // otherwise sent only once on connect (the registry's diff-poll suppresses
    // re-emits once the list is steady), but the manager wipes its whole
    // per-engine cache on any `engineOffline` — so a single reconnect flap
    // (observed on engines behind a NAT/tunnel: offline→online churn) drops the
    // snapshot that was just delivered and the device dropdowns go empty until
    // the list next changes, which for NICs is never. Re-sending on the
    // heartbeat lets the cache self-heal within one interval, exactly like the
    // module-state and systemStats resyncs already do.
    let stateResyncTimer: ReturnType<typeof setInterval> | null = null;

    // The manager offers state patches (ADR-0025); a gap it detects asks for a snapshot.
    ctx.managerConnection.on('hello', (hello: unknown) => states.hello(hello));
    ctx.managerConnection.on('stateResync', () => states.snapshot());

    const onLinkChange = () => tree?.info();
    ctx.managerConnection.on('pathUp', onLinkChange);
    ctx.managerConnection.on('pathDown', onLinkChange);

    ctx.managerConnection.on('connected', () => {
        onLinkChange();
        // Best-effort: this handshake triggers manager-driven auto-start, but
        // it re-sends on the 10s heartbeat below — a dropped packet delays the
        // reconcile one interval at most. Repetition beats retransmission:
        // guaranteed delivery here contributed to the retransmit flood that
        // choked the NO-BR uplink. Except a Start/Stop made during the outage:
        // it rides guaranteed, so the manager adopts it instead of reverting it.
        const running = ctx.runController.isRunning;
        if (ctx.localChanges.takeRunChange()) {
            ctx.managerConnection.send('engineRunningState', { running, localChange: true }, { guaranteeDelivery: true });
        } else {
            ctx.managerConnection.send('engineRunningState', { running });
        }
        // Advertise this host's effective plugin schemas so the manager renders
        // this engine's real capabilities (e.g. hardware encoders) rather than
        // its own host probe. Static per session, so sent once on connect;
        // guaranteed because a dropped packet leaves the manager on its
        // fallback schema until the next reconnect (issue #661).
        ctx.managerConnection.send('capabilities', ctx.pluginSchemas(), {
            guaranteeDelivery: true,
        });
        states.connected();
        if (stateResyncTimer) clearInterval(stateResyncTimer);
        stateResyncTimer = setInterval(() => {
            states.heartbeat();
            // Re-send the running-state handshake too — repetition makes the
            // auto-start reconcile self-healing without per-message
            // retransmits. The manager treats repeats as idempotent
            // (start-retry is desired, both-running is a no-op).
            ctx.managerConnection.send('engineRunningState', {
                running: ctx.runController.isRunning,
            });
            // Re-broadcast device snapshots so the manager's dropdowns survive a
            // cache-wiping reconnect flap (see the note above).
            void sendInitialDeviceSnapshots();
        }, 10_000);
        // Always push a full snapshot of every device type on connect; the
        // registry's polling (started at boot) does change detection.
        ctx.deviceProviders.resetSnapshots();
        void sendInitialDeviceSnapshots();
    });
    // Stats and device polling keep running without a manager: the router's
    // own tree still serves them (ADR-0025).
    ctx.managerConnection.on('disconnected', () => {
        ctx.localChanges.linkDown();
        onLinkChange();
        if (stateResyncTimer) {
            clearInterval(stateResyncTimer);
            stateResyncTimer = null;
        }
        states.disconnected();
        vuBatcher.reset();
    });
}
