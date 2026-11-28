import { describe, it, expect } from 'vitest';
import { emptyEditorLayout, type EditorLayout } from '@media-router/shared-types';
import type { ConnectionState, ModuleState, PortInfo } from '@/stores/engines';
import { pcmCrossing, placeOnPage, shiftRefPosOps } from './crossRefMoves';

function mod(
    id: string,
    ports: PortInfo[] = [],
    position?: { x: number; y: number },
    width?: number,
): ModuleState {
    return {
        instanceId: id,
        pluginId: 'p',
        displayName: id.toUpperCase(),
        running: true,
        enabled: true,
        health: 'ok',
        pendingRestart: false,
        settings: {},
        ports,
        position,
        size: width === undefined ? undefined : { width, height: 100 },
    };
}
const pcmOut: PortInfo = { id: 'out', direction: 'output', streamType: 'audio/pcm', label: 'Out' };
const pcmIn: PortInfo = { id: 'in', direction: 'input', streamType: 'audio/pcm', label: 'In' };
const tsOut: PortInfo = { id: 'ts', direction: 'output', streamType: 'muxed/mpegts', label: 'TS' };
const tsIn: PortInfo = {
    id: 'tsin',
    direction: 'input',
    streamType: 'muxed/mpegts',
    label: 'TS in',
};
const conn = (src: string, sink: string, sp = 'out', kp = 'in'): ConnectionState => ({
    id: `${src}-${sink}`,
    sourceModuleId: src,
    sourcePortId: sp,
    sinkModuleId: sink,
    sinkPortId: kp,
});

describe('pcmCrossing', () => {
    const modules = {
        mic: mod('mic', [pcmOut, tsOut]),
        spk: mod('spk', [pcmIn]),
        enc: mod('enc', [tsIn]),
    };
    const connections = [conn('mic', 'spk'), conn('mic', 'enc', 'ts', 'tsin')];
    const editor: EditorLayout = {
        ...emptyEditorLayout(),
        pages: { 'pg-a': { name: 'A', order: 0 }, 'pg-b': { name: 'B', order: 1 } },
    };

    it('moving one end of a PipeWire wire to another page is refused with a reason', () => {
        expect(pcmCrossing(modules, connections, editor, ['spk'], 'pg-b')).toBe(
            'Would split the PipeWire wire MIC → SPK across pages',
        );
    });

    it('moving both ends together, or a TS wire, is fine', () => {
        expect(pcmCrossing(modules, connections, editor, ['mic', 'spk'], 'pg-b')).toBeNull();
        expect(pcmCrossing(modules, connections, editor, ['enc'], 'pg-b')).toBeNull();
    });

    it('a move that rejoins a split PipeWire wire is fine', () => {
        const split = { ...editor, modulePages: { spk: 'pg-b' } };
        expect(pcmCrossing(modules, connections, split, ['spk'], 'pg-a')).toBeNull();
        // Moving the other end rejoins it too; the TS wire to ENC it splits doesn't count.
        expect(pcmCrossing(modules, connections, split, ['mic'], 'pg-b')).toBeNull();
    });
});

describe('placeOnPage', () => {
    it("keeps the moved group's layout, to the right of the page content, top-aligned on the grid", () => {
        const target = [mod('t1', [], { x: 0, y: 50 }), mod('t2', [], { x: 300, y: 10 }, 260)];
        const moving = [mod('m1', [], { x: 1000, y: 500 }), mod('m2', [], { x: 1100, y: 620 })];
        // Right edge 300 + 260 = 560, + 288 gap (room for two tags) = 848; top 10 snaps to 16.
        expect(placeOnPage(target, moving)).toEqual([
            { id: 'm1', x: 848, y: 16 },
            { id: 'm2', x: 948, y: 136 },
        ]);
    });

    it('an empty page keeps positions; moved modules never count as page content', () => {
        const moving = [mod('m1', [], { x: 7, y: 9 }), mod('m2')];
        expect(placeOnPage([], moving)).toEqual([
            { id: 'm1', x: 7, y: 9 },
            { id: 'm2', x: 100, y: 100 },
        ]);
        expect(placeOnPage(moving, moving)).toEqual(placeOnPage([], moving));
    });
});

describe('shiftRefPosOps', () => {
    const moving = [mod('m1', [], { x: 1000, y: 500 }), mod('m2')];
    const editor: EditorLayout = {
        ...emptyEditorLayout(),
        refs: {
            'out:m1:out': { n: 1, pos: { x: 1250, y: 520 } },
            'in:m1:a:b': { n: 2, pos: { x: 940, y: 560 } },
            'in:m2:in': { n: 3, pos: { x: 50, y: 90 } },
            'out:m1:ts': { n: 4 },
            'out:other:out': { n: 5, pos: { x: 1, y: 2 } },
        },
        nextRef: 6,
    };

    it("moves the dragged tags of each moved module by that module's offset", () => {
        // m1 goes (1000, 500) → (640, 16); m2 from the default (100, 100) → (160, 116).
        const positions = [
            { id: 'm1', x: 640, y: 16 },
            { id: 'm2', x: 160, y: 116 },
        ];
        expect(shiftRefPosOps(editor, moving, positions)).toEqual([
            { op: 'replace', path: '/editor/refs/out:m1:out/pos', value: { x: 890, y: 36 } },
            { op: 'replace', path: '/editor/refs/in:m1:a:b/pos', value: { x: 580, y: 76 } },
            { op: 'replace', path: '/editor/refs/in:m2:in/pos', value: { x: 110, y: 106 } },
        ]);
    });

    it('writes nothing for modules that stay put, tags placed beside their port, or no layout', () => {
        expect(shiftRefPosOps(editor, moving, placeOnPage([], moving))).toEqual([]);
        expect(shiftRefPosOps(editor, moving, [])).toEqual([]);
        expect(shiftRefPosOps(undefined, moving, [{ id: 'm1', x: 0, y: 0 }])).toEqual([]);
    });
});
