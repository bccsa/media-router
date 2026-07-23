import { ref, readonly } from 'vue';

export interface Toast {
    id: number;
    message: string;
    kind: 'error' | 'info';
}

const DEFAULT_TTL_MS = 4000;

// Module-level state — one toast stack for the whole app, no provider needed.
const toasts = ref<Toast[]>([]);
let nextId = 1;

function dismiss(id: number): void {
    toasts.value = toasts.value.filter((t) => t.id !== id);
}

function show(message: string, kind: Toast['kind'] = 'error', ttlMs = DEFAULT_TTL_MS): void {
    // Collapse repeat spam (e.g. dragging the same invalid edge repeatedly):
    // refresh the existing toast instead of stacking duplicates.
    const existing = toasts.value.find((t) => t.message === message && t.kind === kind);
    if (existing) {
        dismiss(existing.id);
    }
    const id = nextId++;
    toasts.value = [...toasts.value, { id, message, kind }];
    setTimeout(() => dismiss(id), ttlMs);
}

/**
 * App-wide transient notifications. `MrToastHost` (mounted once in App.vue)
 * renders the stack; any code calls `toast.show(...)`. Used by the routing
 * editor to explain rejected connections — extend to other transient
 * failures instead of inventing new surfaces.
 */
export function useToast() {
    return { toasts: readonly(toasts), show, dismiss };
}
