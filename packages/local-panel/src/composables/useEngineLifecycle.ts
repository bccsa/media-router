import { ref, watch } from 'vue';
import { useSocketStore } from '../stores/socket';
import { useModuleStore } from '../stores/modules';

/**
 * Engine start/stop with confirmation-driven button state.
 *
 * No optimistic flip: `engineRunning` follows the engine's broadcast only —
 * flipping locally before the emit made a lost press (WAN socket churn) look
 * applied. `enginePending` disables the button until the engine confirms,
 * with a timeout fallback for the no-op case (e.g. stop pressed when the
 * engine is already stopped — no broadcast comes back).
 */
export function useEngineLifecycle(pendingTimeoutMs = 15000) {
    const socketStore = useSocketStore();
    const moduleStore = useModuleStore();

    const enginePending = ref(false);
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;

    function sendEngineCommand(command: 'start' | 'stop') {
        enginePending.value = true;
        socketStore.emit(command);
        if (pendingTimer) clearTimeout(pendingTimer);
        pendingTimer = setTimeout(() => (enginePending.value = false), pendingTimeoutMs);
    }

    watch(
        () => moduleStore.engineRunning,
        () => {
            enginePending.value = false;
            if (pendingTimer) {
                clearTimeout(pendingTimer);
                pendingTimer = null;
            }
        },
    );

    return { enginePending, sendEngineCommand };
}
