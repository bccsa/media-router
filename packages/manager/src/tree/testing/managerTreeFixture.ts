// Shared setup for the manager tree integration tests (not shipped: excluded from the build).
import { vi } from 'vitest';
import { EventEmitter } from 'events';
import { applyTreeOp } from '@media-router/shared-types';
import { TopicBus } from '@media-router/topic-tree';
import { fakeSocket } from '@media-router/topic-tree/dist/testing.js';
import { ConfigStore } from '../../config/ConfigStore.js';
import { PluginRegistry } from '../../plugins/PluginRegistry.js';
import { EngineCommandService } from '../../handlers/EngineCommandService.js';
import { EngineEventForwarder } from '../../handlers/EngineEventForwarder.js';
import { PatchRouter } from '../../PatchRouter.js';
import { RuntimeCache } from '../RuntimeCache.js';
import { EngineView } from '../EngineView.js';
import { ManagerTree } from '../ManagerTree.js';
import { TreePublisher } from '../TreePublisher.js';
import { TreeWrites } from '../TreeWrites.js';
import { AdminWrites } from '../AdminWrites.js';
import { TreeCalls } from '../TreeCalls.js';

const manifest = {
    pluginId: 'audio-output',
    displayName: 'Audio Output',
    ports: [],
    color: '#3b82f6',
    configSchema: {
        properties: {
            volume: { type: 'number', minimum: 0, maximum: 150, 'x-live': true, 'x-maxFrom': 'volumeMax' },
            volumeMax: { type: 'number' },
            channels: { type: 'number', 'x-readOnly': true },
        },
    },
    statusSections: [{ id: 'stats', label: 'Stats', fields: [{ key: 'level', label: 'Level', unit: 'dB' }] }],
};

export function setup() {
    const configStore = new ConfigStore(':memory:');
    configStore.createEngine('e1', 'Router One', 'pw');
    configStore.createProfile('e1', 'default', {
        modules: { m1: { pluginId: 'audio-output', displayName: 'Out', settings: { volume: 80, volumeMax: 150 } } },
        connections: [],
        interlocks: [],
        running: true,
    });
    configStore.setActiveProfile('e1', 'default');
    const online = new Set(['e1']);
    const engineManager = Object.assign(new EventEmitter(), {
        isEngineOnline: (id: string) => online.has(id),
        enginePaths: () => [],
        sendToEngine: vi.fn(),
        refreshEncryptionKeys: vi.fn(),
        notifyRename: vi.fn(),
        dgramListeners: [{ port: 3000 }],
        setListeners: vi.fn(async () => {}),
    }) as any;
    const registry = new PluginRegistry('/nonexistent');
    (registry as any).cache = [manifest];
    const runtime = new RuntimeCache();
    const view = new EngineView({ configStore, runtime, pluginRegistry: registry, engineManager });
    const tree = new ManagerTree({ view, configStore, engineManager, pluginRegistry: registry });
    const bus = new TopicBus(tree, 10);
    const publisher = new TreePublisher(bus, view);
    const engineCommands = new EngineCommandService(configStore, engineManager);
    new EngineEventForwarder(configStore, engineManager, engineCommands, runtime, publisher).setup();
    const patchRouter = new PatchRouter(configStore, engineManager, publisher, registry, runtime);
    const writes = new TreeWrites(patchRouter, view, new AdminWrites({ configStore, engineManager, engineCommands, runtime, publisher, tree }), bus);
    const calls = new TreeCalls({ configStore, engineManager, runtime, publisher, pluginUploads: {} as any });
    const sock = (id: string, patterns: string[]) => {
        const s = fakeSocket(id);
        bus.attach(s);
        const snapshot = bus.subscribe(id, patterns);
        return { s, snapshot };
    };
    const ops = (s: ReturnType<typeof fakeSocket>) => {
        vi.advanceTimersByTime(20);
        return s.frames().flat();
    };
    /** A client mirror: the snapshot, then every frame applied in order. */
    const track = (id: string, patterns: string[]) => {
        const { s, snapshot } = sock(id, patterns);
        const mirror: any = {};
        snapshot.forEach((op) => applyTreeOp(mirror, op));
        let seen = 0;
        const sync = () => {
            vi.advanceTimersByTime(20);
            const frames = s.frames();
            for (const f of frames.slice(seen)) for (const op of f) applyTreeOp(mirror, op);
            seen = frames.length;
            return mirror;
        };
        return { s, mirror, sync };
    };
    const stored = () => configStore.getProfile('e1', 'default') as any;
    return { configStore, engineManager, online, bus, writes, calls, sock, ops, track, stored };
}
