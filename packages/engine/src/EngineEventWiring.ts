import type { ModuleRuntimeState, PatchOp } from '@media-router/shared-types';
import { createLogger } from '@media-router/shared-types';

import type { ModuleManager } from './modules/ModuleManager.js';
import type { MediaRouter } from './routing/MediaRouter.js';
import type { ManagerConnection } from './comms/ManagerConnection.js';
import type { LcpServer } from './comms/LcpServer.js';
import type { PipeWireManager } from './audio/PipeWireManager.js';
import type { LogForwarder } from './logging/LogForwarder.js';
import type { CommandDispatcher } from './commands/CommandDispatcher.js';
import type { EnginePatchRouter } from './EnginePatchRouter.js';
import type { SystemStatsCollector } from './system/SystemStatsCollector.js';

const log = createLogger('Engine');

export interface EngineEventContext {
    logForwarder: LogForwarder;
    moduleManager: ModuleManager;
    managerConnection: ManagerConnection;
    lcpServer: LcpServer;
    pipeWire: PipeWireManager;
    commandDispatcher: CommandDispatcher;
    enginePatchRouter: EnginePatchRouter;
    systemStats: SystemStatsCollector;
    getCurrentConfig: () => Record<string, unknown> | null;
    setCurrentConfig: (config: Record<string, unknown>) => void;
    enrichConfigForLcp: (config: Record<string, unknown>) => Record<string, unknown>;
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

    ctx.moduleManager.on('configUpdated', (instanceId: string, changes: Record<string, unknown>) => {
        log.trace({ instanceId, changes }, 'Plugin auto-detected config');
        const ops = Object.entries(changes).map(([key, value]) => ({
            op: 'replace' as const, path: `/modules/${instanceId}/settings/${key}`, value,
        }));
        ctx.managerConnection.send('patch', { ops });
    });

    // VU data with dedup + heartbeat
    const lastVu = new Map<string, string>();
    const lastVuSent = new Map<string, number>();
    ctx.moduleManager.on('vuData', (instanceId: string, data: number[]) => {
        const key = JSON.stringify(data);
        const prev = lastVu.get(instanceId);
        const lastSent = lastVuSent.get(instanceId) ?? 0;
        const now = Date.now();
        if (key !== prev || now - lastSent >= 1000) {
            lastVu.set(instanceId, key);
            lastVuSent.set(instanceId, now);
            ctx.managerConnection.sendVu(instanceId, data);
            ctx.lcpServer.broadcastVuData(instanceId, data);
        }
    });

    ctx.managerConnection.on('config', (config: unknown) => {
        log.info('Received config from manager');
        ctx.setCurrentConfig(config as Record<string, unknown>);
        // Enrich with lcpType before broadcasting to LCP clients
        const enriched = ctx.enrichConfigForLcp(config as Record<string, unknown>);
        ctx.lcpServer.broadcastConfigUpdate([{ op: 'replace', path: '/', value: enriched }]);
    });

    ctx.managerConnection.on('command', (command: unknown) => {
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
        const { ops } = data as { ops: Array<{ op: string; path: string; value?: unknown }> };
        if (ops?.length > 0) ctx.enginePatchRouter.onPatch('manager', 'manager', ops as PatchOp[]);
    });

    // Handle patches from LCP
    ctx.lcpServer.on('patch', (data: unknown) => {
        const { ops, _socketId } = data as { ops: Array<{ op: string; path: string; value?: unknown }>; _socketId: string };
        if (ops?.length > 0) ctx.enginePatchRouter.onPatch(_socketId, 'lcp', ops as PatchOp[]);
    });

    ctx.managerConnection.on('connected', () => {
        ctx.systemStats.start();
        // Tell the manager whether modules are actually running (not just the engine process).
        // moduleManager.size > 0 means modules were started and are active.
        const modulesRunning = ctx.moduleManager.size > 0;
        ctx.managerConnection.send('engineRunningState', { running: modulesRunning });
        const states = ctx.moduleManager.getAllStates();
        if (Object.keys(states).length > 0) {
            ctx.managerConnection.sendState(states);
        }
        // Send audio device list so the manager can serve it to browsers
        try {
            const devices = ctx.pipeWire.listDevices();
            ctx.managerConnection.send('audioDevices', devices);
        } catch { /* best effort */ }
    });
    ctx.managerConnection.on('disconnected', () => {
        ctx.systemStats.stop();
    });
}
