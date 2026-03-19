import { defineStore } from 'pinia';
import { reactive } from 'vue';

/**
 * Dedicated store for VU meter data.
 *
 * Separated from the engine store because VU data updates at ~15Hz
 * and we need fine-grained reactivity without triggering full Map
 * reassignment on every update.
 *
 * Uses a reactive object so Vue tracks individual property access.
 */
export const useVuStore = defineStore('vuMeters', () => {
    // Key: "engineId/instanceId", Value: array of dB levels per channel
    const levels = reactive<Record<string, number[]>>({});

    function update(engineId: string, instanceId: string, vuData: number[]) {
        const key = `${engineId}/${instanceId}`;
        levels[key] = vuData;
    }

    function get(engineId: string, instanceId: string): number[] | undefined {
        return levels[`${engineId}/${instanceId}`];
    }

    function clear(engineId: string) {
        for (const key of Object.keys(levels)) {
            if (key.startsWith(`${engineId}/`)) {
                delete levels[key];
            }
        }
    }

    return { levels, update, get, clear };
});
