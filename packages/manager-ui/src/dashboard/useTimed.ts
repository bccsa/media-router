import { onUnmounted, ref, type Ref } from 'vue';

/** A value that falls back to `rest` `ms` after each set: a refused-write flash, a failure line, a tapped reason. */
export function useTimed<T>(rest: T, ms: number): { value: Ref<T>; set: (v: T) => void } {
    const value = ref(rest) as Ref<T>;
    let timer: ReturnType<typeof setTimeout> | null = null;
    onUnmounted(() => timer && clearTimeout(timer));
    return {
        value,
        set(v: T) {
            value.value = v;
            if (timer) clearTimeout(timer);
            timer = v === rest ? null : setTimeout(() => (value.value = rest), ms);
        },
    };
}
