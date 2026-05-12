import { defineStore } from 'pinia';
import { reactive, onUnmounted } from 'vue';

/**
 * Dedicated store for VU meter data.
 *
 * Separated from the engine store because VU data updates at ~15Hz
 * and we need fine-grained reactivity without triggering full Map
 * reassignment on every update.
 *
 * Uses a reactive object so Vue tracks individual property access.
 * Auto-clears stale entries after 2s of no updates so a few dropped
 * UDP packets (~15Hz nominal cadence, 1s engine heartbeat) don't flash
 * the meter to zero and look like an audio dropout.
 */
export const useVuStore = defineStore('vuMeters', () => {
    // Key: "engineId/instanceId", Value: array of block levels per channel
    const levels = reactive<Record<string, number[]>>({});
    // Track last update time per key for staleness detection
    const lastUpdate: Record<string, number> = {};
    const STALE_MS = 2000; // hold last value for 2s before zeroing — survives ~30 missed VU cycles at 15Hz

    // Cleanup timer — runs every 500ms, resets stale VU data to zeros
    const cleanupTimer = setInterval(() => {
        const now = Date.now();
        for (const key of Object.keys(lastUpdate)) {
            if (now - lastUpdate[key] > STALE_MS && levels[key]?.some((v) => v > 0)) {
                levels[key] = levels[key].map(() => 0);
            }
        }
    }, 500);

    // Clean up timer when store is disposed
    if (typeof onUnmounted === 'function') {
        try {
            onUnmounted(() => clearInterval(cleanupTimer));
        } catch {
            /* not in component */
        }
    }

    function update(engineId: string, instanceId: string, vuData: number[]) {
        const key = `${engineId}/${instanceId}`;
        levels[key] = vuData;
        lastUpdate[key] = Date.now();
    }

    function get(engineId: string, instanceId: string): number[] | undefined {
        return levels[`${engineId}/${instanceId}`];
    }

    function clear(engineId: string) {
        for (const key of Object.keys(levels)) {
            if (key.startsWith(`${engineId}/`)) {
                delete levels[key];
                delete lastUpdate[key];
            }
        }
    }

    return { levels, update, get, clear };
});
