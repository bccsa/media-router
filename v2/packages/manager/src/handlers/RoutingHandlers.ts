import type { Server as SocketIOServer } from 'socket.io';
import type { ChannelMapEntry } from '@media-router/shared-types';
import type { ConfigStore } from '../config/ConfigStore.js';
import type { EngineConnectionManager } from '../engines/EngineConnectionManager.js';

/**
 * Handles routing operations: connect, disconnect, update (label/channelMap).
 */
export class RoutingHandlers {
    constructor(
        private configStore: ConfigStore,
        private engineManager: EngineConnectionManager,
        private io: SocketIOServer,
    ) {}

    connect(payload: {
        engineId: string;
        sourceModuleId: string;
        sourcePortId: string;
        sinkModuleId: string;
        sinkPortId: string;
        label?: string;
        channelMap?: ChannelMapEntry[];
    }): void {
        const engine = this.configStore.getEngine(payload.engineId);
        if (!engine?.active_profile) return;

        const connId = `${payload.sourceModuleId}:${payload.sourcePortId}-${payload.sinkModuleId}:${payload.sinkPortId}`;

        const connData: Record<string, unknown> = {
            id: connId,
            sourceModuleId: payload.sourceModuleId,
            sourcePortId: payload.sourcePortId,
            sinkModuleId: payload.sinkModuleId,
            sinkPortId: payload.sinkPortId,
        };
        if (payload.label) connData.label = payload.label;
        if (payload.channelMap?.length) connData.channelMap = payload.channelMap;

        this.configStore.modifyProfileConfig(payload.engineId, engine.active_profile as string, (config) => {
            const connections = (config.connections ?? []) as Array<Record<string, unknown>>;
            connections.push(connData);
            config.connections = connections;
            return config;
        });

        if (this.engineManager.isEngineOnline(payload.engineId)) {
            this.engineManager.sendToEngine(payload.engineId, 'command', {
                command: 'routingConnect',
                sourceModuleId: payload.sourceModuleId,
                sourcePortId: payload.sourcePortId,
                sinkModuleId: payload.sinkModuleId,
                sinkPortId: payload.sinkPortId,
                channelMap: payload.channelMap,
            }, { guaranteeDelivery: true });
        }

        this.io.emit('engine:update', {
            engineId: payload.engineId,
            patch: [{ op: 'add', path: '/connections/-', value: connData }],
        });
    }

    disconnect(payload: { engineId: string; connectionId: string }): void {
        const engine = this.configStore.getEngine(payload.engineId);
        if (!engine?.active_profile) return;

        const updatedConfig = this.configStore.modifyProfileConfig(payload.engineId, engine.active_profile as string, (config) => {
            const connections = (config.connections ?? []) as Array<Record<string, unknown>>;
            config.connections = connections.filter((c) => c.id !== payload.connectionId);
            return config;
        });

        if (this.engineManager.isEngineOnline(payload.engineId)) {
            this.engineManager.sendToEngine(payload.engineId, 'command', {
                command: 'routingDisconnect',
                connectionId: payload.connectionId,
            }, { guaranteeDelivery: true });
        }

        this.io.emit('engine:update', {
            engineId: payload.engineId,
            patch: [{ op: 'replace', path: '/connections', value: updatedConfig?.connections ?? [] }],
        });
    }

    update(payload: {
        engineId: string;
        connectionId: string;
        label?: string;
        channelMap?: ChannelMapEntry[];
    }): void {
        const engine = this.configStore.getEngine(payload.engineId);
        if (!engine?.active_profile) return;

        const updatedConfig = this.configStore.modifyProfileConfig(payload.engineId, engine.active_profile as string, (config) => {
            const connections = (config.connections ?? []) as Array<Record<string, unknown>>;
            const conn = connections.find((c) => c.id === payload.connectionId);
            if (!conn) return config;

            if ('label' in payload) conn.label = payload.label;
            if ('channelMap' in payload) conn.channelMap = payload.channelMap;

            config.connections = connections;
            return config;
        });

        if ('channelMap' in payload && this.engineManager.isEngineOnline(payload.engineId)) {
            this.engineManager.sendToEngine(payload.engineId, 'command', {
                command: 'routingUpdate',
                connectionId: payload.connectionId,
                channelMap: payload.channelMap,
            }, { guaranteeDelivery: true });
        }

        const patchOps: Array<{ op: string; path: string; value: unknown }> = [];
        const connections = (updatedConfig?.connections ?? []) as Array<Record<string, unknown>>;
        const idx = connections.findIndex((c) => c.id === payload.connectionId);
        if (idx >= 0) {
            if ('label' in payload) {
                patchOps.push({ op: 'replace', path: `/connections/${idx}/label`, value: payload.label });
            }
            if ('channelMap' in payload) {
                patchOps.push({ op: 'replace', path: `/connections/${idx}/channelMap`, value: payload.channelMap });
            }
        }
        if (patchOps.length > 0) {
            this.io.emit('engine:update', { engineId: payload.engineId, patch: patchOps });
        }
    }
}
