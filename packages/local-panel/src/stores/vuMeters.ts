import { defineStore } from 'pinia';
import { reactive, onUnmounted } from 'vue';

/**
 * VU meter store for the Local Control Panel.
 * Same pattern as manager-ui's vuMeters store — reactive object keyed by instanceId,
 * auto-clears stale entries after 1500ms without update.
 */
export const useVuStore = defineStore('vuMeters', () => {
    const levels = reactive<Record<string, number[]>>({});
    const lastUpdate = reactive<Record<string, number>>({});

    const STALE_MS = 1500;

    function update(instanceId: string, vuData: number[]) {
        levels[instanceId] = vuData;
        lastUpdate[instanceId] = Date.now();
    }

    function get(instanceId: string): number[] {
        return levels[instanceId] ?? [];
    }

    function clear(instanceId: string) {
        delete levels[instanceId];
        delete lastUpdate[instanceId];
    }

    function clearAll() {
        for (const key of Object.keys(levels)) {
            delete levels[key];
            delete lastUpdate[key];
        }
    }

    // Auto-clear stale VU data
    const cleanupTimer = setInterval(() => {
        const now = Date.now();
        for (const key of Object.keys(lastUpdate)) {
            if (now - lastUpdate[key] > STALE_MS) {
                const currentLevels = levels[key];
                if (currentLevels && currentLevels.some(v => v > 0)) {
                    levels[key] = currentLevels.map(() => 0);
                }
            }
        }
    }, 500);

    try {
        onUnmounted(() => clearInterval(cleanupTimer));
    } catch { /* store created outside component */ }

    return { levels, update, get, clear, clearAll };
});
