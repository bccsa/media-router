import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

export interface LogEntry {
    level: number;
    time: string;
    name: string;
    msg: string;
    instanceId?: string;
    moduleId?: string;
    [key: string]: unknown;
}

/** Pino level numbers → labels */
export const LEVEL_LABELS: Record<number, string> = {
    10: 'trace',
    20: 'debug',
    30: 'info',
    40: 'warn',
    50: 'error',
    60: 'fatal',
};

export const LEVEL_COLORS: Record<number, string> = {
    10: 'var(--text-muted)',
    20: 'var(--text-muted)',
    30: 'var(--text-secondary)',
    40: '#eab308',
    50: '#ef4444',
    60: '#ef4444',
};

const MAX_ENTRIES = 2000;

export const useLogStore = defineStore('logs', () => {
    /** All log entries keyed by engineId */
    const entries = ref<Map<string, LogEntry[]>>(new Map());

    function addEntries(engineId: string, batch: LogEntry[]) {
        let list = entries.value.get(engineId);
        if (!list) {
            list = [];
            entries.value.set(engineId, list);
        }
        list.push(...batch);
        if (list.length > MAX_ENTRIES) {
            list.splice(0, list.length - MAX_ENTRIES);
        }
    }

    function setHistory(engineId: string, history: LogEntry[]) {
        entries.value.set(engineId, history.slice(-MAX_ENTRIES));
    }

    function clear(engineId: string) {
        entries.value.set(engineId, []);
    }

    /**
     * Re-key cached entries after a server-side engine rename. Without this
     * the detail view under the new id renders empty while the old buffer
     * sits orphaned in the Map.
     */
    function rename(oldEngineId: string, newEngineId: string) {
        if (oldEngineId === newEngineId) return;
        const buf = entries.value.get(oldEngineId);
        if (buf === undefined) return;
        entries.value.delete(oldEngineId);
        entries.value.set(newEngineId, buf);
    }

    function getEntries(engineId: string): LogEntry[] {
        return entries.value.get(engineId) ?? [];
    }

    return { entries, addEntries, setHistory, clear, rename, getEntries };
});
