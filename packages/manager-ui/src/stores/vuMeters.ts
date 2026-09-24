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
 * Auto-clears stale entries after 2.5s of no updates so a dropped batch
 * (10Hz batches, unchanged meters re-sent once per 1s heartbeat) doesn't
 * flash the meter to zero and look like an audio dropout (#677).
 */
export const useVuStore = defineStore('vuMeters', () => {
    // Key: "engineId/instanceId", Value: array of block levels per channel
    const levels = reactive<Record<string, number[]>>({});
    // Track last update time per key for staleness detection
    const lastUpdate: Record<string, number> = {};
    const STALE_MS = 2500; // hold last value 2.5 s before zeroing — 2× the 1 s heartbeat plus WAN jitter

    // Cleanup timer — runs every 500ms, resets stale VU data to zeros
    const cleanupTimer = setInterval(() => {
        const now = Date.now();
        for (const key of Object.keys(lastUpdate)) {
            if (now - lastUpdate[key] > STALE_MS && levels[key]?.some((v) => v > 0)) {
                // Trace for #677-class reports: a zeroed meter is a delivery gap, not silence.
                console.debug(`[vu] stale meter zeroed ${key} after ${now - lastUpdate[key]} ms`);
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

    /**
     * Move all `${oldEngineId}/*` keys to `${newEngineId}/*` after a
     * server-side rename. VU sampling is high-frequency (~15Hz) so a
     * clear-and-wait would visibly flatline the meters; rekeying preserves
     * the in-flight values.
     */
    function rename(oldEngineId: string, newEngineId: string) {
        if (oldEngineId === newEngineId) return;
        const prefix = `${oldEngineId}/`;
        for (const key of Object.keys(levels)) {
            if (key.startsWith(prefix)) {
                const newKey = `${newEngineId}/${key.slice(prefix.length)}`;
                levels[newKey] = levels[key];
                lastUpdate[newKey] = lastUpdate[key];
                delete levels[key];
                delete lastUpdate[key];
            }
        }
    }

    return { levels, update, get, clear, rename };
});
