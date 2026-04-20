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

    // --- Audio device hotplug detection ---
    // Poll every 2s (like v1's 1s but less aggressive). Only send when changed.
    let lastDeviceJson = '';
    let devicePollTimer: ReturnType<typeof setInterval> | null = null;

    function pollDevices() {
        if (!ctx.managerConnection.isConnected) return;
        try {
            const devices = ctx.pipeWire.listDevices();
            const json = JSON.stringify(devices);
            if (json !== lastDeviceJson) {
                lastDeviceJson = json;
                ctx.managerConnection.send('audioDevices', devices);
                log.info(
                    { count: devices.length },
                    'Audio device list changed — pushed to manager',
                );
            }
        } catch (err) {
            log.warn({ err }, 'Device poll failed');
        }
    }

    function startDevicePoll() {
        if (devicePollTimer) return;
        devicePollTimer = setInterval(pollDevices, 2000);
    }

    function stopDevicePoll() {
        if (devicePollTimer) {
            clearInterval(devicePollTimer);
            devicePollTimer = null;
        }
    }

    ctx.managerConnection.on('connected', () => {
        ctx.systemStats.start();
        const modulesRunning = ctx.moduleManager.size > 0;
        ctx.managerConnection.send('engineRunningState', { running: modulesRunning });
        const states = ctx.moduleManager.getAllStates();
        if (Object.keys(states).length > 0) {
            ctx.managerConnection.sendState(states);
        }
        // Always send full device list on connect + start polling
        lastDeviceJson = '';
        pollDevices();
        startDevicePoll();
    });
    ctx.managerConnection.on('disconnected', () => {
        ctx.systemStats.stop();
        stopDevicePoll();
    });
}
