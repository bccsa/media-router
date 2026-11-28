import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { computed, ref } from 'vue';
import type { EngineState } from '@/stores/engines';

const m = vi.hoisted(() => ({
    engine: null as unknown as { value: EngineState },
    setCenter: vi.fn(),
    editor: vi.fn(),
    addConnection: vi.fn(),
    removeConnection: vi.fn(),
    toast: vi.fn(),
    write: vi.fn(),
}));
vi.mock('@vue-flow/core', () => ({
    useVueFlow: () => ({ setCenter: m.setCenter, findNode: () => undefined }),
}));
vi.mock('@/composables/usePatch', () => ({
    patch: {
        editor: (...a: unknown[]) => m.editor(...a),
        addConnection: (...a: unknown[]) => m.addConnection(...a),
        removeConnection: (...a: unknown[]) => m.removeConnection(...a),
    },
}));
vi.mock('@/composables/useToast', () => ({ useToast: () => ({ show: m.toast }) }));
vi.mock('@/stores/engines', () => ({
    useEngineStore: () => ({ getEngine: () => m.engine.value }),
}));
vi.mock('@/stores/socket', () => ({
    useSocketStore: () => ({ write: (...a: unknown[]) => m.write(...a) }),
}));

import { HIGHLIGHT_MS, useCrossRefs } from './useCrossRefs';
import { NUMBERING_DELAY_MS } from './useRefNumbering';
import { TAG_SIZE } from '@/utils/xrefCanvas';

const port = (id: string, direction: string, streamType: string, maxConnections = -1) => ({
    id,
    label: id === 'in' ? 'In' : 'Out',
    direction,
    streamType,
    maxConnections,
});
const mod = (id: string, ports: unknown[]) => ({
    instanceId: id,
    displayName: id.toUpperCase(),
    position: { x: 0, y: 0 },
    ports,
});
const conn = (src: string, sink: string) => ({
    id: `${src}:out-${sink}:in`,
    sourceModuleId: src,
    sourcePortId: 'out',
    sinkModuleId: sink,
    sinkPortId: 'in',
});

/** enc → dec across pages, enc → loc on Page 1, a PipeWire wire mic → spk across pages. */
function makeEngine(): EngineState {
    return {
        engineId: 'eng-1',
        modules: {
            enc: mod('enc', [port('out', 'output', 'audio/302m')]),
            loc: mod('loc', [port('in', 'input', 'audio/302m')]),
            dec: mod('dec', [port('in', 'input', 'audio/302m', 1)]),
            mix: mod('mix', [port('in', 'input', 'audio/302m')]),
            mic: mod('mic', [port('out', 'output', 'audio/pcm')]),
            spk: mod('spk', [port('in', 'input', 'audio/pcm')]),
        },
        connections: [conn('enc', 'dec'), conn('enc', 'loc'), conn('mic', 'spk')],
        editor: {
            pages: { 'pg-1': { name: 'Page 1', order: 0 }, 'pg-2': { name: 'Outputs', order: 1 } },
            modulePages: {
                enc: 'pg-1',
                loc: 'pg-1',
                mic: 'pg-1',
                dec: 'pg-2',
                mix: 'pg-2',
                spk: 'pg-2',
            },
            refs: { 'in:dec:in': { n: 1, pos: { x: 500, y: 60 } } },
            tagged: {},
            nextRef: 2,
        },
    } as unknown as EngineState;
}

function setup() {
    m.engine = ref(makeEngine()) as unknown as { value: EngineState };
    const current = ref('pg-1');
    const pages = {
        currentPage: computed(() => current.value),
        selectPage: vi.fn((id: string) => (current.value = id)),
    };
    const keepView = vi.fn();
    const x = useCrossRefs(
        () => 'eng-1',
        computed(() => m.engine.value),
        pages,
        keepView,
    );
    return { x, pages, keepView, current };
}

describe('useCrossRefs', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        for (const f of [m.setCenter, m.editor, m.addConnection, m.removeConnection, m.toast])
            f.mockReset();
        m.write.mockReset().mockResolvedValue({ rejected: [] });
    });
    afterEach(() => vi.useRealTimers());

    it("draws the page's tags, stubs and direct wires; a PipeWire wire across pages is a grey tag", () => {
        const { x, current } = setup();
        expect(x.pageRefs.value.map((r) => r.key).sort()).toEqual(['out:enc:out', 'out:mic:out']);
        expect(x.pageStubs.value.map((s) => s.id).sort()).toEqual([
            'ref:out:enc:out',
            'ref:out:mic:out',
        ]);
        expect(x.pageDirect.value.map((c) => c.id)).toEqual(['enc:out-loc:in']);
        expect(x.derived.value.refs['out:mic:out'].readOnly).toBe(true);
        current.value = 'pg-2';
        expect(x.pageRefs.value.map((r) => r.key).sort()).toEqual(['in:dec:in', 'in:spk:in']);
    });

    it('numbers the missing tags of every page in one quiet write, never the read-only ones', () => {
        setup();
        vi.advanceTimersByTime(NUMBERING_DELAY_MS);
        expect(m.write).toHaveBeenCalledTimes(1);
        expect(m.write.mock.calls[0][0]).toEqual([
            { op: 'add', path: '/engines/eng-1/editor/refs/out:enc:out', value: {} },
        ]);
        expect(m.editor).not.toHaveBeenCalled();
        expect(m.toast).not.toHaveBeenCalled();
    });

    it('goToRef switches page without its fit, centres on the tag and glows briefly', () => {
        const { x, pages, keepView } = setup();
        x.goToRef('in:dec:in');
        expect(keepView).toHaveBeenCalledTimes(1);
        expect(pages.selectPage).toHaveBeenCalledWith('pg-2');
        expect(m.setCenter).toHaveBeenCalledWith(
            500 + TAG_SIZE.width / 2,
            60 + TAG_SIZE.height / 2,
            expect.objectContaining({ zoom: 1 }),
        );
        expect(x.highlighted.value).toBe('in:dec:in');
        vi.advanceTimersByTime(HIGHLIGHT_MS);
        expect(x.highlighted.value).toBeNull();

        // Same page: no switch.
        x.goToRef('in:spk:in');
        expect(pages.selectPage).toHaveBeenCalledTimes(1);
        x.goToRef('nope');
        expect(m.setCenter).toHaveBeenCalledTimes(2);
    });

    it("linkPorts connects and puts a port's first tag where the wire was dropped", () => {
        const { x } = setup();
        const from = { moduleId: 'loc', portId: 'in', direction: 'input' as const };
        expect(x.linkPorts(from, { moduleId: 'enc', portId: 'out' }, { x: 300, y: 100 })).toBe(
            true,
        );
        expect(m.addConnection).toHaveBeenCalledWith('eng-1', {
            id: 'enc:out-loc:in',
            sourceModuleId: 'enc',
            sourcePortId: 'out',
            sinkModuleId: 'loc',
            sinkPortId: 'in',
        });
        expect(m.editor).toHaveBeenCalledWith('eng-1', [
            {
                op: 'add',
                path: '/editor/refs/in:loc:in/pos',
                value: { x: 300 - TAG_SIZE.width, y: 100 - TAG_SIZE.height / 2 },
            },
        ]);
    });

    it('linkPorts leaves an existing tag where it is; a refused pair toasts and writes nothing', () => {
        const { x } = setup();
        const enc = { moduleId: 'enc', portId: 'out', direction: 'output' as const };
        expect(x.linkPorts(enc, { moduleId: 'mix', portId: 'in' }, { x: 9, y: 9 })).toBe(true);
        expect(m.addConnection).toHaveBeenCalledTimes(1);
        expect(m.editor).not.toHaveBeenCalled();

        const dec = { moduleId: 'dec', portId: 'in', direction: 'input' as const };
        expect(x.linkPorts(dec, { moduleId: 'enc', portId: 'out' })).toBe(false);
        expect(m.toast).toHaveBeenCalledTimes(1);
        expect(m.addConnection).toHaveBeenCalledTimes(1);
    });

    it('opens the link picker with candidates from other pages, and picking links at the drop point', () => {
        const { x } = setup();
        const enc = { moduleId: 'enc', portId: 'out', direction: 'output' as const };
        x.openLinkPicker(enc, 40, 50, { x: 300, y: 100 });
        expect(x.linkPicker.value).toMatchObject({ x: 40, y: 50, dropAt: { x: 300, y: 100 } });
        // dec is full; mix takes another feed.
        expect(x.linkPicker.value!.candidates.map((c) => c.moduleId)).toEqual(['mix']);
        x.pickLink(x.linkPicker.value!.candidates[0]);
        expect(x.linkPicker.value).toBeNull();
        expect(m.addConnection).toHaveBeenCalledWith(
            'eng-1',
            expect.objectContaining({ id: 'enc:out-mix:in' }),
        );
    });

    it('opens no picker on a layout with one page', () => {
        const { x } = setup();
        m.engine.value.editor!.pages = { 'pg-1': { name: 'Page 1', order: 0 } };
        x.openLinkPicker({ moduleId: 'enc', portId: 'out', direction: 'output' }, 1, 1);
        expect(x.linkPicker.value).toBeNull();
    });

    it('unlink asks first, naming both ends and their pages, then removes the connection', () => {
        const { x } = setup();
        x.unlink('enc:out-dec:in');
        expect(x.pendingUnlink.value).toEqual({
            connectionId: 'enc:out-dec:in',
            from: 'ENC/Out (Page 1)',
            to: 'DEC/In (Outputs)',
        });
        expect(m.removeConnection).not.toHaveBeenCalled();
        x.confirmUnlink();
        expect(m.removeConnection).toHaveBeenCalledWith('eng-1', 'enc:out-dec:in');
        expect(x.pendingUnlink.value).toBeNull();
    });

    it('writes tagging, names, dragged places and their clearing', () => {
        const { x, current } = setup();
        x.setTagged('enc:out-loc:in', true);
        x.setTagged('enc:out-loc:in', false);
        x.renameRef('in:dec:in', 'Main');
        x.renameRef('in:dec:in', null);
        x.renameRef('in:spk:in', 'grey tags have no record');
        x.saveRefPositions([
            { key: 'out:enc:out', x: 10.4, y: 20.6 },
            { key: 'out:mic:out', x: 1, y: 1 },
        ]);
        expect(m.editor.mock.calls.map((c) => c[1])).toEqual([
            [{ op: 'add', path: '/editor/tagged/enc:out-loc:in', value: true }],
            [{ op: 'remove', path: '/editor/tagged/enc:out-loc:in' }],
            [{ op: 'add', path: '/editor/refs/in:dec:in/name', value: 'Main' }],
            [{ op: 'remove', path: '/editor/refs/in:dec:in/name' }],
            [{ op: 'add', path: '/editor/refs/out:enc:out/pos', value: { x: 10, y: 21 } }],
        ]);
        expect(x.clearPositionOps()).toEqual([]);
        current.value = 'pg-2';
        expect(x.clearPositionOps()).toEqual([
            { op: 'remove', path: '/editor/refs/in:dec:in/pos' },
        ]);
    });
});
