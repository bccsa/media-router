import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { Device } from '@media-router/shared-types';

/**
 * Generic device-list store.
 *
 * The engine's `DeviceProviderRegistry` emits `deviceList { type, devices }`
 * whenever any plugin's device list changes; the manager caches per type and
 * broadcasts `engine:deviceList` to browsers in the `watch:<engineId>` room.
 * This store holds those lists keyed by `${engineId}::${type}` so any
 * component (settings panels, add-module dialogs, future UI) can render
 * device options without knowing which plugin owns the type.
 *
 * Initial snapshot: components emit the `device:list` Socket.IO RPC on mount
 * and feed the ack response into `set()`. After that, live updates arrive
 * via `applyPush()` from the socket store — no polling timers.
 */
export const useDeviceStore = defineStore('devices', () => {
    // Map reassigned as a whole on change so Vue's reactivity tracks it.
    const lists = ref<Map<string, Device[]>>(new Map());

    function key(engineId: string, type: string): string {
        return `${engineId}::${type}`;
    }

    function get(engineId: string, type: string): Device[] {
        return lists.value.get(key(engineId, type)) ?? [];
    }

    function set(engineId: string, type: string, devices: Device[]): void {
        lists.value.set(key(engineId, type), devices);
        lists.value = new Map(lists.value);
    }

    /** Handler for socket push `engine:deviceList`. */
    function applyPush(data: { engineId: string; type: string; devices: Device[] }): void {
        set(data.engineId, data.type, data.devices);
    }

    function clear(engineId: string): void {
        for (const k of Array.from(lists.value.keys())) {
            if (k.startsWith(`${engineId}::`)) lists.value.delete(k);
        }
        lists.value = new Map(lists.value);
    }

    /**
     * Re-key all `${oldEngineId}::*` entries to `${newEngineId}::*` after a
     * server-side rename. Without this the renamed engine's settings panels
     * render empty dropdowns until the engine republishes — possibly never
     * if the engine just sits idle.
     */
    function rename(oldEngineId: string, newEngineId: string): void {
        if (oldEngineId === newEngineId) return;
        const prefix = `${oldEngineId}::`;
        let changed = false;
        for (const k of Array.from(lists.value.keys())) {
            if (k.startsWith(prefix)) {
                const suffix = k.slice(prefix.length);
                const value = lists.value.get(k)!;
                lists.value.delete(k);
                lists.value.set(`${newEngineId}::${suffix}`, value);
                changed = true;
            }
        }
        if (changed) lists.value = new Map(lists.value);
    }

    return { get, set, applyPush, clear, rename };
});
