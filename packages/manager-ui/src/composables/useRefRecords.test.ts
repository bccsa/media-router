import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { computed, nextTick, ref } from 'vue';
import { emptyEditorLayout, type EditorLayout } from '@media-router/shared-types';
import type { DerivedRefs, RefNode } from '@/utils/crossRefTypes';

const m = vi.hoisted(() => ({ write: vi.fn(), toast: vi.fn() }));
vi.mock('@/stores/socket', () => ({
    useSocketStore: () => ({ write: (...a: unknown[]) => m.write(...a) }),
}));
vi.mock('@/composables/useToast', () => ({ useToast: () => ({ show: m.toast }) }));

import { REF_PASS_DELAY_MS, useRefRecords } from './useRefRecords';

const tag = (key: string, extra: Partial<RefNode> = {}) =>
    ({ key, readOnly: false, links: [], ...extra }) as unknown as RefNode;

function setup(tags: RefNode[], stored: EditorLayout['refs'] = {}) {
    const state = ref<DerivedRefs>({
        directConnectionIds: [],
        links: [],
        refs: Object.fromEntries(tags.map((t) => [t.key, t])),
    });
    const editor = ref<EditorLayout>({ ...emptyEditorLayout(), refs: stored });
    const engineId = ref('eng-1');
    const numbering = useRefRecords(
        () => engineId.value,
        computed(() => state.value),
        () => editor.value,
    );
    /** Replace the tags (a new derivation, as deriveRefs makes). */
    const setTags = async (next: RefNode[]) => {
        state.value = { ...state.value, refs: Object.fromEntries(next.map((t) => [t.key, t])) };
        await nextTick();
    };
    return { numbering, setTags, engineId };
}

/** Let the write's then/catch/finally chain settle. */
async function settle() {
    for (let i = 0; i < 6; i++) await Promise.resolve();
}

const sentKeys = (call = 0) =>
    (m.write.mock.calls[call][0] as Array<{ path: string }>).map((op) => op.path);

describe('useRefRecords', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        m.write.mockReset();
        m.toast.mockReset();
    });
    afterEach(() => vi.useRealTimers());

    it('adds every missing record in one write after a quiet time, skipping numbered and read-only tags', async () => {
        m.write.mockResolvedValue({ rejected: [] });
        setup([
            tag('out:a:out'),
            tag('in:b:in'),
            tag('out:c:out', { n: 3 }),
            tag('in:d:in', { readOnly: true }),
        ]);
        vi.advanceTimersByTime(REF_PASS_DELAY_MS - 1);
        expect(m.write).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(m.write).toHaveBeenCalledTimes(1);
        expect(m.write.mock.calls[0][0]).toEqual([
            { op: 'add', path: '/engines/eng-1/editor/refs/out:a:out', value: {} },
            { op: 'add', path: '/engines/eng-1/editor/refs/in:b:in', value: {} },
        ]);
    });

    it('never re-sends a key while it is in flight', async () => {
        let ack!: (v: { rejected: unknown[] }) => void;
        m.write
            .mockReturnValueOnce(new Promise((r) => (ack = r)))
            .mockResolvedValue({ rejected: [] });
        const { setTags, numbering } = setup([tag('out:a:out')]);
        vi.advanceTimersByTime(REF_PASS_DELAY_MS);
        expect(numbering.inFlight.has('out:a:out')).toBe(true);

        await setTags([tag('out:a:out'), tag('in:b:in')]);
        vi.advanceTimersByTime(REF_PASS_DELAY_MS);
        expect(m.write).toHaveBeenCalledTimes(2);
        expect(sentKeys(1)).toEqual(['/engines/eng-1/editor/refs/in:b:in']);

        ack({ rejected: [] });
        await settle();
        expect(numbering.inFlight.size).toBe(0);
    });

    it('does not retry a refused key while it stays missing, and tries once more if it comes back', async () => {
        const prefix = '/engines/eng-1/editor/refs/';
        m.write.mockResolvedValue({ rejected: [{ path: `${prefix}out:a:out`, reason: 'nope' }] });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { setTags, numbering } = setup([tag('out:a:out')]);
        vi.advanceTimersByTime(REF_PASS_DELAY_MS);
        await settle();
        expect(numbering.failed.has('out:a:out')).toBe(true);

        // Another change re-runs the pass: the refused key is left alone, nothing is sent.
        await setTags([tag('out:a:out'), tag('in:b:in', { n: 1 })]);
        vi.advanceTimersByTime(REF_PASS_DELAY_MS);
        expect(m.write).toHaveBeenCalledTimes(1);

        // Gone (its link removed), then back: one more try.
        await setTags([tag('in:b:in', { n: 1 })]);
        vi.advanceTimersByTime(REF_PASS_DELAY_MS);
        await setTags([tag('out:a:out'), tag('in:b:in', { n: 1 })]);
        vi.advanceTimersByTime(REF_PASS_DELAY_MS);
        expect(m.write).toHaveBeenCalledTimes(2);
        expect(m.toast).not.toHaveBeenCalled();
        warn.mockRestore();
    });

    it('leaves a key free after a lost connection, for the next change to send', async () => {
        m.write
            .mockRejectedValueOnce(new Error('Not connected'))
            .mockResolvedValue({ rejected: [] });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { setTags, numbering } = setup([tag('out:a:out')]);
        vi.advanceTimersByTime(REF_PASS_DELAY_MS);
        await settle();
        expect(numbering.failed.size).toBe(0);
        expect(numbering.inFlight.size).toBe(0);

        await setTags([tag('out:a:out'), tag('in:b:in')]);
        vi.advanceTimersByTime(REF_PASS_DELAY_MS);
        expect(sentKeys(1)).toHaveLength(2);
        expect(m.toast).not.toHaveBeenCalled();
        warn.mockRestore();
    });

    it('forgets the dragged place of a stored tag that is no longer drawn, in the same write', () => {
        m.write.mockResolvedValue({ rejected: [] });
        setup([tag('out:a:out'), tag('in:b:in', { n: 2, pos: { x: 1, y: 1 } })], {
            'in:b:in': { n: 2, pos: { x: 1, y: 1 } },
            'out:gone:out': { n: 3, name: 'Kept', pos: { x: 9, y: 9 } },
            'out:old:out': { n: 4 },
        });
        vi.advanceTimersByTime(REF_PASS_DELAY_MS);
        expect(m.write.mock.calls[0][0]).toEqual([
            { op: 'add', path: '/engines/eng-1/editor/refs/out:a:out', value: {} },
            { op: 'remove', path: '/engines/eng-1/editor/refs/out:gone:out/pos' },
        ]);
    });

    it('sends nothing when every tag has its number', () => {
        setup([tag('out:a:out', { n: 1 })]);
        vi.advanceTimersByTime(REF_PASS_DELAY_MS * 2);
        expect(m.write).not.toHaveBeenCalled();
    });

    it('starts fresh for another engine', async () => {
        const prefix = '/engines/eng-1/editor/refs/';
        m.write.mockResolvedValue({ rejected: [{ path: `${prefix}out:a:out`, reason: 'nope' }] });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { numbering, engineId } = setup([tag('out:a:out')]);
        vi.advanceTimersByTime(REF_PASS_DELAY_MS);
        await settle();
        expect(numbering.failed.size).toBe(1);
        engineId.value = 'eng-2';
        await nextTick();
        expect(numbering.failed.size).toBe(0);
        warn.mockRestore();
    });
});
