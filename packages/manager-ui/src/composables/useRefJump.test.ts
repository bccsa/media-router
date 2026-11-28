import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { computed, ref } from 'vue';
import type { EngineState } from '@/stores/engines';
import type { DerivedRefs, RefNode } from '@/utils/crossRefTypes';

const m = vi.hoisted(() => ({
    setCenter: vi.fn(),
    boxes: {} as Record<string, unknown>,
    initialized: [] as Array<() => void>,
}));
vi.mock('@vue-flow/core', () => ({
    useVueFlow: () => ({
        setCenter: m.setCenter,
        findNode: (id: string) => m.boxes[id],
        onNodesInitialized: (cb: () => void) => m.initialized.push(cb),
    }),
}));

import { HIGHLIGHT_MS, useRefJump } from './useRefJump';
import { TAG_GAP, TAG_SIZE } from '@/utils/xrefCanvas';

const tag = (key: string, page: string, extra: Partial<RefNode> = {}) => {
    const [kind, moduleId, portId] = key.split(':');
    return { key, kind, moduleId, portId, page, ...extra } as RefNode;
};

/** A dragged input tag on page 2, an undragged one on port 16 of a 16-output module there, one on page 1. */
function setup() {
    const engine = ref({
        engineId: 'eng-1',
        modules: {
            dec: { position: { x: 0, y: 0 } },
            tx: { position: { x: 0, y: 0 } },
            loc: { position: { x: 0, y: 0 } },
        },
    } as unknown as EngineState);
    const derived = computed<DerivedRefs>(() => ({
        directConnectionIds: [],
        links: [],
        refs: Object.fromEntries(
            [
                tag('in:dec:in', 'pg-2', { pos: { x: 500, y: 60 } }),
                tag('out:tx:o15', 'pg-2'),
                tag('in:loc:in', 'pg-1', { pos: { x: 10, y: 20 } }),
            ].map((t) => [t.key, t]),
        ),
    }));
    const current = ref('pg-1');
    const pages = {
        currentPage: computed(() => current.value),
        selectPage: vi.fn((id: string) => (current.value = id)),
    };
    const keepView = vi.fn();
    const j = useRefJump(
        computed(() => engine.value),
        derived,
        pages,
        keepView,
    );
    return { j, pages, keepView };
}

const pageMeasured = () => m.initialized.forEach((cb) => cb());
/** The 16-output module measured: port 16's handle 44 + 24·15 px down, at its 280 px wide right edge. */
const measureTx = () => {
    m.boxes.tx = {
        position: { x: 0, y: 0 },
        dimensions: { width: 280, height: 440 },
        handleBounds: { source: [{ id: 'o15', x: 274, y: 404, width: 12, height: 12 }] },
    };
    m.boxes['out:tx:o15'] = { dimensions: { width: 100, height: TAG_SIZE.height } };
};

describe('useRefJump', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        m.setCenter.mockReset();
        m.boxes = {};
        m.initialized.length = 0;
    });
    afterEach(() => vi.useRealTimers());

    it('switches page without its fit, centres on the tag and glows briefly', () => {
        const { j, pages, keepView } = setup();
        j.goToRef('in:dec:in');
        expect(keepView).toHaveBeenCalledTimes(1);
        expect(pages.selectPage).toHaveBeenCalledWith('pg-2');
        expect(m.setCenter).toHaveBeenCalledWith(
            500 + TAG_SIZE.width / 2,
            60 + TAG_SIZE.height / 2,
            expect.objectContaining({ zoom: 1 }),
        );
        expect(j.highlighted.value).toBe('in:dec:in');
        vi.advanceTimersByTime(HIGHLIGHT_MS);
        expect(j.highlighted.value).toBeNull();

        // Same page: no switch. An unknown tag: nothing.
        j.goToRef('out:tx:o15');
        expect(pages.selectPage).toHaveBeenCalledTimes(1);
        j.goToRef('nope');
        expect(m.setCenter).toHaveBeenCalledTimes(2);
    });

    it("on another page centres again on the tag's port once its module is measured", () => {
        const { j } = setup();
        j.goToRef('out:tx:o15');
        // Not on the canvas yet: beside a default module's right edge, at mid-height.
        expect(m.setCenter).toHaveBeenLastCalledWith(
            200 + TAG_GAP + TAG_SIZE.width / 2,
            40,
            expect.anything(),
        );
        // Measured as other nodes come in: nothing until the tag's module is.
        pageMeasured();
        expect(m.setCenter).toHaveBeenCalledTimes(1);
        measureTx();
        pageMeasured();
        expect(m.setCenter).toHaveBeenLastCalledWith(280 + TAG_GAP + 50, 410, expect.anything());
        // Once only.
        pageMeasured();
        expect(m.setCenter).toHaveBeenCalledTimes(2);
    });

    it('leaves the view alone after the glow, and after a jump on the same page', () => {
        const { j } = setup();
        j.goToRef('out:tx:o15');
        vi.advanceTimersByTime(HIGHLIGHT_MS);
        measureTx();
        pageMeasured();
        expect(m.setCenter).toHaveBeenCalledTimes(1);

        j.goToRef('in:dec:in');
        pageMeasured();
        expect(m.setCenter).toHaveBeenCalledTimes(2);
    });
});
