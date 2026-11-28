import { describe, it, expect } from 'vitest';
import { emptyEditorLayout, type EditorLayout } from '@media-router/shared-types';
import type { ConnectionState, ModuleState, PortInfo } from '@/stores/engines';
import { linkCandidates } from './crossRefCandidates';

function port(
    id: string,
    direction: PortInfo['direction'],
    over: Partial<PortInfo> = {},
): PortInfo {
    return { id, direction, streamType: 'audio/302m', label: id, maxConnections: -1, ...over };
}
function mod(id: string, name: string, ports: PortInfo[]): ModuleState {
    return {
        instanceId: id,
        pluginId: 'p',
        displayName: name,
        running: true,
        enabled: true,
        health: 'ok',
        pendingRestart: false,
        settings: {},
        ports,
    };
}
function conn(src: string, srcPort: string, sink: string, sinkPort: string): ConnectionState {
    return {
        id: `${src}-${sink}`,
        sourceModuleId: src,
        sourcePortId: srcPort,
        sinkModuleId: sink,
        sinkPortId: sinkPort,
    };
}

/** Pages A (0), B (1), C (2); the origin module `src` sits on A. */
const editor: EditorLayout = {
    ...emptyEditorLayout(),
    pages: {
        'pg-c': { name: 'Return', order: 2 },
        'pg-a': { name: 'Intake', order: 0 },
        'pg-b': { name: 'Output', order: 1 },
    },
    modulePages: {
        zed: 'pg-b',
        amp: 'pg-b',
        ret: 'pg-c',
        full: 'pg-b',
        pw: 'pg-b',
        near: 'pg-a',
        other: 'pg-b',
    },
    refs: { 'in:ret:in': { n: 7, name: 'Back feed' } },
    nextRef: 8,
};
const modules: Record<string, ModuleState> = {
    src: mod('src', 'Source', [
        port('out', 'output'),
        port('pcm', 'output', { streamType: 'audio/pcm' }),
    ]),
    near: mod('near', 'Nearby', [port('in', 'input')]),
    zed: mod('zed', 'Zed out', [
        port('in', 'input', { streamInfo: { language: 'nor' } }),
        port('in2', 'input', { label: 'Second' }),
        port('legacy', 'input', { hideWhenUnconnected: true }),
        port('out', 'output'),
    ]),
    amp: mod('amp', 'Amp', [port('in', 'input')]),
    ret: mod('ret', 'Return', [port('in', 'input')]),
    full: mod('full', 'Full', [port('in', 'input', { maxConnections: 1 })]),
    pw: mod('pw', 'PipeWire sink', [port('in', 'input', { streamType: 'audio/pcm' })]),
    other: mod('other', 'Other', [
        port('out', 'output'),
        port('video', 'input', { streamType: 'video/raw' }),
    ]),
};
const connections = [
    conn('other', 'out', 'full', 'in'),
    conn('other', 'out', 'ret', 'in'),
    conn('src', 'out', 'amp', 'in'),
];
const engine = { modules, connections };
const at = (c: { pageName: string; moduleName: string; portLabel: string }) =>
    `${c.pageName} / ${c.moduleName} / ${c.portLabel}`;

describe('linkCandidates', () => {
    it('lists compatible inputs on other pages in page, module and port order', () => {
        const list = linkCandidates(engine, editor, {
            moduleId: 'src',
            portId: 'out',
            direction: 'output',
        });
        expect(list.map(at)).toEqual([
            'Output / Zed out / nor',
            'Output / Zed out / Second',
            'Return / Return / in',
        ]);
        expect(list[0]).toMatchObject({
            pageId: 'pg-b',
            moduleId: 'zed',
            portId: 'in',
            streamType: 'audio/302m',
        });
    });

    it('leaves out same-page, full, PipeWire, incompatible, hidden and already-wired ports', () => {
        const ids = linkCandidates(engine, editor, {
            moduleId: 'src',
            portId: 'out',
            direction: 'output',
        }).map((c) => `${c.moduleId}:${c.portId}`);
        for (const gone of ['near:in', 'full:in', 'pw:in', 'other:video', 'zed:legacy', 'amp:in'])
            expect(ids).not.toContain(gone);
    });

    it('names the tag a candidate port already has', () => {
        const ret = linkCandidates(engine, editor, {
            moduleId: 'src',
            portId: 'out',
            direction: 'output',
        }).find((c) => c.moduleId === 'ret');
        expect(ret?.existingRefLabel).toBe('Back feed');
    });

    it('from an input, lists outputs on other pages', () => {
        const list = linkCandidates(engine, editor, {
            moduleId: 'near',
            portId: 'in',
            direction: 'input',
        });
        expect(list.map((c) => `${c.moduleId}:${c.portId}`)).toEqual(['other:out', 'zed:out']);
    });

    it('a PipeWire or unknown origin port has no candidates', () => {
        expect(
            linkCandidates(engine, editor, { moduleId: 'src', portId: 'pcm', direction: 'output' }),
        ).toEqual([]);
        expect(
            linkCandidates(engine, editor, {
                moduleId: 'src',
                portId: 'nope',
                direction: 'output',
            }),
        ).toEqual([]);
    });

    it('a single-page layout has nothing to link to', () => {
        expect(
            linkCandidates(engine, undefined, {
                moduleId: 'src',
                portId: 'out',
                direction: 'output',
            }),
        ).toEqual([]);
    });
});
