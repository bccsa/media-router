import { computed, onUnmounted, ref, watch, type Ref } from 'vue';

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 4;

type Point = { x: number; y: number };
const clamp = (v: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v));
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y) || 1;
const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/**
 * Zoom and pan for a dashboard with Pinch zoom on (ADR-0026): pinch or
 * Ctrl+wheel zooms about the fingers/cursor, a drag that starts on the
 * background pans, a double tap there resets. Widgets keep their own
 * pointers: only pointers that went down on a `data-pan-surface` count.
 */
export function useZoomPan(el: Ref<HTMLElement | null>, enabled: () => boolean) {
    const scale = ref(1);
    const tx = ref(0);
    const ty = ref(0);
    const pointers = new Map<number, Point>();
    let pinch: { d0: number; s0: number; p: Point } | null = null;

    const local = (e: { clientX: number; clientY: number }): Point => {
        const r = el.value!.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    /** Content point under `at` before the zoom stays under it after. */
    function zoomAt(next: number, at: Point) {
        const s = clamp(next);
        const px = (at.x - tx.value) / scale.value;
        const py = (at.y - ty.value) / scale.value;
        tx.value = at.x - px * s;
        ty.value = at.y - py * s;
        scale.value = s;
    }

    function reset() {
        scale.value = 1;
        tx.value = 0;
        ty.value = 0;
    }

    function onWheel(e: WheelEvent) {
        if (!enabled() || !e.ctrlKey) return;
        e.preventDefault();
        zoomAt(scale.value * Math.exp(-e.deltaY * 0.002), local(e));
    }

    function onDown(e: PointerEvent) {
        const surface = (e.target as HTMLElement | null)?.closest?.('[data-pan-surface]');
        if (!enabled() || !surface || (e.target as HTMLElement) !== surface) return;
        pointers.set(e.pointerId, local(e));
        el.value?.setPointerCapture?.(e.pointerId);
        if (pointers.size === 2) {
            const [a, b] = [...pointers.values()];
            const m = mid(a, b);
            pinch = { d0: dist(a, b), s0: scale.value, p: { x: (m.x - tx.value) / scale.value, y: (m.y - ty.value) / scale.value } };
        }
    }

    function onMove(e: PointerEvent) {
        const prev = pointers.get(e.pointerId);
        if (!prev) return;
        const now = local(e);
        pointers.set(e.pointerId, now);
        if (pointers.size === 1) {
            tx.value += now.x - prev.x;
            ty.value += now.y - prev.y;
        } else if (pinch) {
            const [a, b] = [...pointers.values()];
            const m = mid(a, b);
            scale.value = clamp(pinch.s0 * (dist(a, b) / pinch.d0));
            tx.value = m.x - pinch.p.x * scale.value;
            ty.value = m.y - pinch.p.y * scale.value;
        }
    }

    function onUp(e: PointerEvent) {
        pointers.delete(e.pointerId);
        if (pointers.size < 2) pinch = null;
    }

    function onDoubleClick(e: MouseEvent) {
        if (enabled() && (e.target as HTMLElement)?.hasAttribute?.('data-pan-surface')) reset();
    }

    const handlers: Array<[string, (e: any) => void]> = [
        ['wheel', onWheel],
        ['pointerdown', onDown],
        ['pointermove', onMove],
        ['pointerup', onUp],
        ['pointercancel', onUp],
        ['dblclick', onDoubleClick],
    ];
    watch(
        el,
        (node, old) => {
            for (const [ev, fn] of handlers) old?.removeEventListener(ev, fn);
            for (const [ev, fn] of handlers) node?.addEventListener(ev, fn, ev === 'wheel' ? { passive: false } : undefined);
        },
        { immediate: true },
    );
    onUnmounted(() => {
        for (const [ev, fn] of handlers) el.value?.removeEventListener(ev, fn);
    });
    watch(enabled, (on) => !on && reset());

    const transform = computed(() =>
        scale.value === 1 && tx.value === 0 && ty.value === 0 ? undefined : `translate(${tx.value}px, ${ty.value}px) scale(${scale.value})`,
    );
    return { scale, transform, reset, zoomAt };
}
