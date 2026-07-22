import type { ModuleRuntimeState, PatchOp } from '@media-router/shared-types';
import { createLogger, safeParse, PatchEnvelopeSchema } from '@media-router/shared-types';

import type { ModuleManager } from './modules/ModuleManager.js';
import type { MediaRouter } from './routing/MediaRouter.js';
import type { ManagerConnection } from './comms/ManagerConnection.js';
import { ModuleStateBatcher } from './comms/ModuleStateBatcher.js';
import { VuBatcher } from './comms/VuBatcher.js';
import type { LcpServer } from './comms/LcpServer.js';
import type { PipeWireManager } from './audio/PipeWireManager.js';
import type { LogForwarder } from './logging/LogForwarder.js';
import type { CommandDispatcher } from './commands/CommandDispatcher.js';
import type { EnginePatchRouter } from './EnginePatchRouter.js';
import type { SystemStatsCollector } from './system/SystemStatsCollector.js';
import type { DeviceProviderRegistry } from './system/DeviceProviderRegistry.js';
import type { ModuleRunController } from './modules/ModuleRunController.js';

const log = createLogger('Engine');

export interface EngineEventContext {
    logForwarder: LogForwarder;
    moduleManager: ModuleManager;
    managerConnection: ManagerConnection;
    lcpServer: LcpServer;
    pipeWire: PipeWireManager;
    deviceProviders: DeviceProviderRegistry;
    commandDispatcher: CommandDispatcher;
    enginePatchRouter: EnginePatchRouter;
    systemStats: SystemStatsCollector;
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
}

export function wireEngineEvents(ctx: EngineEventContext): void {
    ctx.logForwarder.on('logs', (batch: unknown[]) => {
        if (ctx.managerConnection.isConnected) {
            ctx.managerConnection.send('logs', batch);
        }
    });

    // Manager-bound module state goes through batch + dedup (see
    // ModuleStateBatcher for the traffic math); dropped batches are healed by
    // the guaranteed 10s snapshot resync below. The LCP broadcast stays
    // unbatched and keeps the full state, vuData included.
    const stateBatcher = new ModuleStateBatcher((batch) =>
        ctx.managerConnection.sendState(batch),
    );

    ctx.moduleManager.on('stateChange', (instanceId: string, state: ModuleRuntimeState) => {
        ctx.lcpServer.broadcastState(instanceId, state);
        stateBatcher.enqueue(instanceId, state);
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
            ctx.managerConnection.send('patch', { ops });
            // A plugin auto-write can change its dynamic port set (mpegts-
            // demuxer persisting discovered streams, plan Phase 3). Re-resolve
            // unconditionally — refreshPorts diffs the resolved list and
            // skips the patch when nothing changed, so the engine doesn't
            // need to know which plugin config keys are port-affecting.
            ctx.refreshModulePorts(instanceId);
        },
    );

    // VU: batched + deduped on its way to the manager (see VuBatcher for the
    // WAN rationale). The LCP broadcast stays per-module and immediate — it's
    // loopback, not the WAN flow — but reuses the batcher's dedup verdict.
    const vuBatcher = new VuBatcher((batch) => ctx.managerConnection.send('vu', { batch }));
    ctx.moduleManager.on('vuData', (instanceId: string, data: number[]) => {
        if (vuBatcher.enqueue(instanceId, data)) {
            ctx.lcpServer.broadcastVuData(instanceId, data);
        }
    });

    // Clean up VU + state dedup maps when modules are destroyed
    ctx.moduleManager.on('moduleDeleted', (instanceId: string) => {
        vuBatcher.drop(instanceId);
        stateBatcher.drop(instanceId);
    });

    ctx.managerConnection.on('config', (config: unknown) => {
        if (typeof config !== 'object' || config === null) {
            log.warn('Received invalid config from manager — expected object');
            return;
        }
        log.info('Received config from manager');
        ctx.setCurrentConfig(config as Record<string, unknown>);
        const enriched = ctx.enrichConfigForLcp(config as Record<string, unknown>);
        ctx.lcpServer.broadcastConfigUpdate([{ op: 'replace', path: '/', value: enriched }]);
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
    // Rare operator-initiated traffic — no retransmit-flood risk (that rule is
    // for repeating telemetry, see the deviceList note below).
    ctx.lcpServer.on('control', (command: unknown) => {
        const cmd = command as Record<string, unknown>;
        if (cmd.action === 'start' || cmd.action === 'stop') {
            ctx.commandDispatcher.dispatch({ command: cmd.action });
            ctx.managerConnection.send(
                'lcpEngineCommand',
                { command: cmd.action },
                { guaranteeDelivery: true },
            );
        }
    });

    // Handle patches from manager
    ctx.managerConnection.on('patch', (data: unknown) => {
        const envelope = safeParse(PatchEnvelopeSchema, data, 'manager:patch', log);
        if (envelope)
            ctx.enginePatchRouter.onPatch('manager', 'manager', envelope.ops as PatchOp[]);
    });

    // Handle patches from LCP (already validated by LcpServer, but _socketId comes through)
    ctx.lcpServer.on('patch', (data: unknown) => {
        const d = data as { ops?: unknown[]; _socketId?: string };
        const envelope = safeParse(PatchEnvelopeSchema, d, 'lcp:patch', log);
        if (envelope)
            ctx.enginePatchRouter.onPatch(d._socketId ?? 'lcp', 'lcp', envelope.ops as PatchOp[]);
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

    // Best-effort full-state snapshot (connect + 10s resync). The batcher
    // refreshes its dedup cache and drops any pending batch — the snapshot
    // already contains everything queued. Best-effort on purpose: the resync
    // repeats every 10s, so a drop self-heals next tick; guaranteed delivery
    // turned each snapshot into a 10x retransmit storm on lossy uplinks.
    const sendStateSnapshot = (): void => {
        const lean = stateBatcher.snapshot(ctx.moduleManager.getAllStates());
        if (!lean) return;
        ctx.managerConnection.sendState(lean);
    };

    ctx.managerConnection.on('connected', () => {
        ctx.systemStats.start();
        // Best-effort: this handshake triggers manager-driven auto-start, but
        // it re-sends on the 10s heartbeat below — a dropped packet delays the
        // reconcile one interval at most. Repetition beats retransmission:
        // guaranteed delivery here contributed to the retransmit flood that
        // choked the NO-BR uplink.
        ctx.managerConnection.send('engineRunningState', {
            running: ctx.runController.isRunning,
        });
        // Advertise this host's effective plugin schemas so the manager renders
        // this engine's real capabilities (e.g. hardware encoders) rather than
        // its own host probe. Static per session, so sent once on connect;
        // guaranteed because a dropped packet leaves the manager on its
        // fallback schema until the next reconnect (issue #661).
        ctx.managerConnection.send('capabilities', ctx.pluginSchemas(), {
            guaranteeDelivery: true,
        });
        sendStateSnapshot();
        if (stateResyncTimer) clearInterval(stateResyncTimer);
        stateResyncTimer = setInterval(() => {
            sendStateSnapshot();
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
        // Always push a full snapshot of every device type on connect, then
        // let the registry's internal polling take over change detection.
        ctx.deviceProviders.resetSnapshots();
        void sendInitialDeviceSnapshots();
        ctx.deviceProviders.startPolling();
    });
    ctx.managerConnection.on('disconnected', () => {
        ctx.systemStats.stop();
        ctx.deviceProviders.stopPolling();
        if (stateResyncTimer) {
            clearInterval(stateResyncTimer);
            stateResyncTimer = null;
        }
        stateBatcher.reset();
        vuBatcher.reset();
    });
}
