import { onUnmounted, watch } from 'vue';
import { useSocketStore } from '@/stores/socket';

/**
 * Keep tree patterns subscribed while the component lives. When they change,
 * the new set is subscribed before the old is released, so data both cover
 * is never dropped in between.
 */
export function useTopics(patterns: () => string[]): void {
    const socket = useSocketStore();
    let release: (() => void) | null = null;
    watch(
        patterns,
        (next) => {
            const previous = release;
            release = next.length > 0 ? socket.subscribe(next) : null;
            previous?.();
        },
        { immediate: true, deep: true },
    );
    onUnmounted(() => {
        release?.();
        release = null;
    });
}
