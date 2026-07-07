import type { ModuleRuntimeState, PatchOp } from '@media-router/shared-types';
import { createLogger, safeParse, PatchEnvelopeSchema } from '@media-router/shared-types';

import type { ModuleManager } from './modules/ModuleManager.js';
import type { MediaRouter } from './routing/MediaRouter.js';
import type { ManagerConnection } from './comms/ManagerConnection.js';
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

    ctx.moduleManager.on('stateChange', (instanceId: string, state: ModuleRuntimeState) => {
        ctx.managerConnection.sendState({ [instanceId]: state });
        ctx.lcpServer.broadcastState(instanceId, state);
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

    // VU data with dedup + heartbeat
    const lastVu = new Map<string, number[]>();
    const lastVuSent = new Map<string, number>();
    const vuChanged = (prev: number[] | undefined, next: number[]): boolean => {
        if (!prev || prev.length !== next.length) return true;
        for (let i = 0; i < next.length; i++) {
            if (prev[i] !== next[i]) return true;
        }
        return false;
    };
    ctx.moduleManager.on('vuData', (instanceId: string, data: number[]) => {
        const prev = lastVu.get(instanceId);
        const lastSent = lastVuSent.get(instanceId) ?? 0;
        const now = Date.now();
        if (vuChanged(prev, data) || now - lastSent >= 1000) {
            lastVu.set(instanceId, data);
            lastVuSent.set(instanceId, now);
            ctx.managerConnection.sendVu(instanceId, data);
            ctx.lcpServer.broadcastVuData(instanceId, data);
        }
    });

    // Clean up VU dedup maps when modules are destroyed
    ctx.moduleManager.on('moduleDeleted', (instanceId: string) => {
        lastVu.delete(instanceId);
        lastVuSent.delete(instanceId);
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

    // LCP lifecycle commands (start/stop)
    ctx.lcpServer.on('control', (command: unknown) => {
        const cmd = command as Record<string, unknown>;
        if (cmd.action === 'start') {
            ctx.commandDispatcher.dispatch({ command: 'start' });
            ctx.managerConnection.send('lcpEngineCommand', { command: 'start' });
        } else if (cmd.action === 'stop') {
            ctx.commandDispatcher.dispatch({ command: 'stop' });
            ctx.managerConnection.send('lcpEngineCommand', { command: 'stop' });
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
    let stateResyncTimer: ReturnType<typeof setInterval> | null = null;

    ctx.managerConnection.on('connected', () => {
        ctx.systemStats.start();
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
        const states = ctx.moduleManager.getAllStates();
        if (Object.keys(states).length > 0) {
            ctx.managerConnection.sendState(states, { guaranteeDelivery: true });
        }
        if (stateResyncTimer) clearInterval(stateResyncTimer);
        stateResyncTimer = setInterval(() => {
            const snapshot = ctx.moduleManager.getAllStates();
            if (Object.keys(snapshot).length > 0) {
                ctx.managerConnection.sendState(snapshot, { guaranteeDelivery: true });
            }
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
    });
}
