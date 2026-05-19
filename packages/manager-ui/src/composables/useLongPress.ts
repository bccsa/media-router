import { onUnmounted } from 'vue';

/**
 * Long-press detector for mobile contexts. Returns touch handlers to bind on
 * the host element; the callback fires after `delayMs` of contact with no
 * end or move events. Used by `ModuleNode.vue` to surface a context menu on
 * a long touch.
 */
export function useLongPress(callback: (event: TouchEvent) => void, delayMs = 500) {
    let timer: ReturnType<typeof setTimeout> | null = null;

    function start(event: TouchEvent): void {
        timer = setTimeout(() => {
            timer = null;
            callback(event);
        }, delayMs);
    }

    function cancel(): void {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
    }

    onUnmounted(cancel);

    return { onTouchStart: start, onTouchEnd: cancel, onTouchMove: cancel };
}
