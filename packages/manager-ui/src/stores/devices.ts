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
 * Initial snapshot: components do one HTTP `GET
 * /api/v1/engines/:id/system/devices/:type` on mount and feed the result into
 * `set()`. After that, live updates arrive via `applyPush()` from the socket
 * store — no polling timers.
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

    return { get, set, applyPush, clear };
});
