import { onBeforeUnmount, type Ref, watchEffect } from 'vue';

export interface AutoFitOptions {
    min: number;
    max: number;
}

/**
 * Shrink the font size of a container's first element child until its
 * scroll dimensions fit within the container's client box. Runs on text
 * change and on container resize (ResizeObserver).
 *
 * Works with both horizontal and vertical writing modes — `scrollWidth` /
 * `scrollHeight` report the laid-out content size regardless of direction.
 */
export function useAutoFitText(
    containerRef: Ref<HTMLElement | null>,
    text: Ref<string>,
    opts: AutoFitOptions,
): void {
    let ro: ResizeObserver | null = null;

    function fit() {
        const el = containerRef.value;
        if (!el || !text.value) return;
        const inner = el.firstElementChild as HTMLElement | null;
        if (!inner) return;
        const w = el.clientWidth;
        const h = el.clientHeight;
        if (w <= 0 || h <= 0) return;

        let lo = opts.min;
        let hi = opts.max;
        while (hi - lo > 1) {
            const mid = Math.floor((lo + hi) / 2);
            inner.style.fontSize = `${mid}px`;
            if (inner.scrollHeight <= h && inner.scrollWidth <= w) lo = mid;
            else hi = mid;
        }
        inner.style.fontSize = `${lo}px`;
    }

    // Re-fit whenever the text changes (microtask defer to let Vue patch first).
    watchEffect(() => {
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        text.value;
        queueMicrotask(fit);
    });

    // Re-fit when the container resizes.
    watchEffect(() => {
        ro?.disconnect();
        const el = containerRef.value;
        if (!el) return;
        ro = new ResizeObserver(() => fit());
        ro.observe(el);
    });

    onBeforeUnmount(() => ro?.disconnect());
}
