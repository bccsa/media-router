// A PatchRouter over one persistent config, for the editor batch tests (not shipped: excluded from the build).
import { vi } from 'vitest';
import type { PatchOp } from '@media-router/shared-types';
import { PatchRouter } from '../PatchRouter.js';
import type { ConfigOp } from '../tree/TreePublisher.js';

type Obj = Record<string, unknown>;

/** A profile with two modules (m1 → m2 on `out-0` → `in-0`) and an optional editor layout. */
export function profile(editor?: Obj): Obj {
    const ports = [
        { id: 'in-0', direction: 'input', streamType: 'audio/302m' },
        { id: 'out-0', direction: 'output', streamType: 'audio/302m' },
        { id: 'out-1', direction: 'output', streamType: 'audio/302m' },
    ];
    return {
        modules: {
            m1: { pluginId: 'p', ports, settings: {} },
            m2: { pluginId: 'p', ports, settings: {} },
        },
        connections: [
            {
                id: 'c1',
                sourceModuleId: 'm1',
                sourcePortId: 'out-0',
                sinkModuleId: 'm2',
                sinkPortId: 'in-0',
            },
        ],
        interlocks: [],
        ...(editor && { editor }),
    };
}

/** `manifestPorts: []` makes the plugin a dynamic-port one (pairCount regenerates its ports). */
export function harness(config: Obj, opts: { manifestPorts?: unknown[] } = {}) {
    const sent: PatchOp[][] = [];
    const published: ConfigOp[] = [];
    const configStore = {
        getEngine: () => ({ engine_id: 'e1', active_profile: 'p' }),
        modifyProfileConfig: (_e: string, _p: string, fn: (c: Obj) => Obj) => fn(config),
    };
    const engineManager = {
        isEngineOnline: () => true,
        sendToEngine: vi.fn((_e: string, _t: string, msg: { ops: PatchOp[] }) =>
            sent.push(msg.ops),
        ),
    };
    const publisher = {
        config: vi.fn((_e: string, entries: ConfigOp[]) => published.push(...entries)),
        info: vi.fn(),
    };
    const manifest = opts.manifestPorts ? { pluginId: 'p', ports: opts.manifestPorts } : undefined;
    const pluginRegistry = {
        find: () => manifest,
        overlayManifest: () => {},
        enrichModule: () => {},
    };
    const runtime = {
        getPluginSchemas: () => undefined,
        getData: () => undefined,
        purgeModuleStates: vi.fn(),
        clearModuleTombstones: vi.fn(),
    };
    const router = new PatchRouter(
        configStore as any,
        engineManager as any,
        publisher as any,
        pluginRegistry as any,
        runtime as any,
    );
    const write = (ops: PatchOp[], sender = 'browser-1') => {
        sent.length = 0;
        published.length = 0;
        return router.write(sender, 'e1', ops);
    };
    const editor = () => config.editor as any;
    /** Published ops the sender had not applied: the cascades. */
    const cascades = () => published.filter((e) => !e.fromSender).map((e) => e.op);
    return { router, config, sent, published, write, editor, cascades };
}
