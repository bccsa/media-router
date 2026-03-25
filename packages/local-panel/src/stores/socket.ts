import { defineStore } from 'pinia';
import { ref } from 'vue';
import { io, type Socket } from 'socket.io-client';
import { useModuleStore } from './modules';
import { useVuStore } from './vuMeters';

/**
 * Socket.IO store for the Local Control Panel.
 * Connects to the engine's LcpServer on localhost:8081.
 *
 * Simple approach:
 * - On connect: request full config + states
 * - Receive: config, allStates, moduleState, vuData, engineRunning
 * - Send: volume, mute, start, stop
 * - No live config sync yet — will add step by step
 */
export const useSocketStore = defineStore('socket', () => {
    const connected = ref(false);
    let socket: Socket | null = null;

    function connect() {
        if (socket) return;

        const moduleStore = useModuleStore();
        const vuStore = useVuStore();

        socket = io(window.location.origin, {
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionAttempts: Infinity,
        });

        socket.on('connect', () => {
            connected.value = true;
        });

        socket.on('disconnect', () => {
            connected.value = false;
        });

        // Combined init event — config + runtime states + engineRunning in one payload
        socket.on('init', (data: { engineRunning: boolean; ip?: string; hostname?: string; buildNumber?: string; config: Record<string, unknown> }) => {
            moduleStore.engineRunning = data.engineRunning;
            if (data.ip) moduleStore.engineIp = data.ip;
            if (data.hostname) moduleStore.engineHostname = data.hostname;
            if (data.buildNumber) moduleStore.buildNumber = data.buildNumber;
            moduleStore.applyConfig(data.config);
        });

        // Individual module state update (health, running, badges, etc.)
        socket.on('moduleState', (data: { instanceId: string; state: unknown }) => {
            moduleStore.updateState(data.instanceId, data.state);
        });

        // VU meter data (~10Hz)
        socket.on('vuData', (data: { instanceId: string; vuData: number[] }) => {
            vuStore.update(data.instanceId, data.vuData);
        });

        // Config update from engine (live sync — when manager-ui or other LCPs change settings)
        socket.on('configUpdate', (patch: unknown) => {
            if (Array.isArray(patch)) {
                moduleStore.applyPatch(patch as Array<{ op: string; path: string; value?: unknown }>);
            }
        });

        // Engine running state
        socket.on('engineRunning', (running: boolean) => {
            moduleStore.engineRunning = running;
        });
    }

    function emit(event: string, data?: unknown) {
        socket?.emit(event, data);
    }

    function disconnect() {
        socket?.disconnect();
        socket = null;
        connected.value = false;
    }

    return { connected, connect, emit, disconnect };
});
