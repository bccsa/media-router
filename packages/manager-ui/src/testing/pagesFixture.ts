// Engines for the usePages tests (not shipped: only tests import it).
import type { EditorLayout } from '@media-router/shared-types';
import type { EngineState } from '@/stores/engines';

export const port = (id: string, direction: string, streamType: string) => ({
    id,
    direction,
    streamType,
});
export const mod = (id: string, ports: unknown[], x = 500, y = 300) => ({
    instanceId: id,
    displayName: id.toUpperCase(),
    position: { x, y },
    ports,
});
export const conn = (src: string, sink: string) => ({
    id: `${src}:out-${sink}:in`,
    sourceModuleId: src,
    sourcePortId: 'out',
    sinkModuleId: sink,
    sinkPortId: 'in',
});

/** enc → dec (302M) and mic → spk (PipeWire), plus src2 already on "Sources". */
export function engineWith(editor?: EditorLayout): EngineState {
    return {
        engineId: 'eng-1',
        modules: {
            enc: mod('enc', [port('out', 'output', 'audio/302m')]),
            dec: mod('dec', [port('in', 'input', 'audio/302m')]),
            mic: mod('mic', [port('out', 'output', 'audio/pcm')]),
            spk: mod('spk', [port('in', 'input', 'audio/pcm')]),
            src2: mod('src2', [], 0, 32),
        },
        connections: [conn('enc', 'dec'), conn('mic', 'spk')],
        editor,
    } as unknown as EngineState;
}

export const twoPages = (): EditorLayout => ({
    pages: { 'pg-1': { name: 'Page 1', order: 0 }, 'pg-src': { name: 'Sources', order: 1 } },
    modulePages: { enc: 'pg-1', dec: 'pg-1', mic: 'pg-1', spk: 'pg-1', src2: 'pg-src' },
    refs: {},
    tagged: {},
    nextRef: 1,
});

/** Where usePages remembers the page picked for eng-1. */
export const PAGE_KEY = 'mr.routing.page.eng-1';
