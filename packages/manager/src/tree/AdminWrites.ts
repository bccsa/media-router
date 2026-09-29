import {
    CreateGroupSchema,
    ManagerSettingsSchema,
    ProfileQuerySchema,
    ReorderEnginesSchema,
    UpdateGroupSchema,
    joinPath,
    type WriteRejection,
} from '@media-router/shared-types';
import type { ConfigStore } from '../config/ConfigStore.js';
import type { EngineConnectionManager } from '../engines/EngineConnectionManager.js';
import type { EngineCommandService } from '../handlers/EngineCommandService.js';
import type { RuntimeCache } from './RuntimeCache.js';
import type { TreePublisher } from './TreePublisher.js';
import type { ManagerTree } from './ManagerTree.js';
import { activateProfile } from './profileActivation.js';
import { reject, type WriteItem } from './TreeWrites.js';

export interface AdminWritesDeps {
    configStore: ConfigStore;
    engineManager: EngineConnectionManager;
    engineCommands: EngineCommandService;
    runtime: RuntimeCache;
    publisher: TreePublisher;
    tree: ManagerTree;
}

const GROUP_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const GROUP_FIELDS = ['name', 'color', 'collapsed'];

/** Writes to router info, reorder, profiles, groups and manager settings. */
export class AdminWrites {
    constructor(private readonly d: AdminWritesDeps) {}

    async apply(kind: string, engineId: string, group: WriteItem[]): Promise<WriteRejection[]> {
        switch (kind) {
            case 'info':
                return group.flatMap((g) => this.info(engineId, g));
            case 'reorder':
                return this.reorder(group);
            case 'engine-delete':
                return group.flatMap((g) => this.deleteEngine(g));
            case 'profiles':
                return group.flatMap((g) => this.profile(engineId, g));
            case 'groups':
                return this.groups(group);
            case 'settings':
                return this.settings(group);
            default:
                return group.map((g) => reject(g, 'not writable'));
        }
    }

    private info(engineId: string, item: WriteItem): WriteRejection[] {
        const { configStore, engineCommands, publisher } = this.d;
        const engine = configStore.getEngine(engineId);
        const { op, path } = item;
        if (!engine) return [reject(item, 'unknown engine')];
        if (op.op !== 'replace') return [reject(item, 'not writable')];
        switch (path[3]) {
            case 'name':
                if (typeof op.value !== 'string' || op.value.length === 0) return [reject(item, 'expected a name')];
                configStore.updateEngine(engineId, op.value);
                break;
            case 'running':
                if (typeof op.value !== 'boolean') return [reject(item, 'expected boolean')];
                engineCommands.setRunning(engineId, op.value);
                engineCommands.sendCommand(engineId, op.value ? 'start' : 'stop');
                break;
            case 'activeProfile': {
                const error = typeof op.value === 'string' ? activateProfile(this.d, engineId, op.value) : 'expected a profile name';
                if (error) return [reject(item, error)];
                break;
            }
        }
        publisher.info(engineId);
        return [];
    }

    /** Moves in the sidebar: groupId and sortOrder of any number of engines, one transaction. */
    private reorder(group: WriteItem[]): WriteRejection[] {
        const { configStore, publisher } = this.d;
        const updates = new Map<string, { engineId: string; groupId: string; sortOrder: number }>();
        for (const { op, path } of group) {
            const engine = configStore.getEngine(path[1]);
            if (!engine || op.op !== 'replace') return group.map((g) => reject(g, 'invalid reorder'));
            const u = updates.get(path[1]) ?? {
                engineId: path[1],
                groupId: engine.group_id as string,
                sortOrder: engine.sort_order as number,
            };
            if (path[3] === 'groupId') u.groupId = op.value as string;
            else u.sortOrder = op.value as number;
            updates.set(path[1], u);
        }
        const parsed = ReorderEnginesSchema.safeParse({ updates: [...updates.values()] });
        const known = new Set(configStore.getAllGroups().map((g) => g.id as string));
        if (!parsed.success || parsed.data.updates.some((u) => !known.has(u.groupId))) {
            return group.map((g) => reject(g, 'invalid reorder'));
        }
        configStore.reorderEngines(parsed.data.updates);
        for (const u of parsed.data.updates) publisher.info(u.engineId);
        return [];
    }

    private deleteEngine(item: WriteItem): WriteRejection[] {
        const { configStore, engineManager, runtime, publisher } = this.d;
        const engineId = item.path[1];
        if (!configStore.getEngine(engineId)) return [reject(item, 'unknown engine')];
        configStore.deleteEngine(engineId);
        engineManager.refreshEncryptionKeys();
        runtime.clearEngine(engineId);
        publisher.info(engineId);
        return [];
    }

    private profile(engineId: string, item: WriteItem): WriteRejection[] {
        const { configStore, publisher } = this.d;
        const engine = configStore.getEngine(engineId);
        const name = item.path[3];
        if (!engine) return [reject(item, 'unknown engine')];
        if (!ProfileQuerySchema.shape.profileName.safeParse(name).success) return [reject(item, 'invalid profile name')];
        if (item.op.op === 'add') {
            const config = (item.op.value as { config?: Record<string, unknown> } | undefined)?.config ?? {};
            configStore.createProfile(engineId, name, config);
        } else if (item.op.op === 'remove') {
            if (engine.active_profile === name) return [reject(item, 'Cannot delete the active profile')];
            configStore.deleteProfile(engineId, name);
        } else {
            return [reject(item, 'not writable')];
        }
        publisher.profiles(engineId);
        return [];
    }

    private groups(group: WriteItem[]): WriteRejection[] {
        const { configStore, publisher, tree } = this.d;
        const rejected: WriteRejection[] = [];
        const order = new Map<string, number>();
        const touched = new Set<string>();
        for (const item of group) {
            const [, gid, field] = item.path;
            const { op } = item;
            if (!gid || !GROUP_ID.test(gid)) {
                rejected.push(reject(item, 'invalid group id'));
            } else if (item.path.length === 2 && op.op === 'add') {
                const parsed = CreateGroupSchema.safeParse(op.value);
                if (!parsed.success || configStore.getGroup(gid)) {
                    rejected.push(reject(item, 'invalid group'));
                } else {
                    configStore.createGroup(gid, parsed.data.name, parsed.data.color ?? null);
                    touched.add(gid);
                }
            } else if (item.path.length === 2 && op.op === 'remove') {
                const existing = configStore.getGroup(gid);
                if (!existing || existing.is_default === 1) rejected.push(reject(item, 'Cannot delete this group'));
                else this.deleteGroup(gid);
            } else if (item.path.length === 3 && field === 'sort_order' && typeof op.value === 'number') {
                order.set(gid, op.value);
            } else if (item.path.length === 3 && GROUP_FIELDS.includes(field) && op.op === 'replace') {
                const parsed = UpdateGroupSchema.safeParse({ groupId: gid, [field]: op.value });
                if (!parsed.success || !configStore.getGroup(gid)) {
                    rejected.push(reject(item, 'invalid group field'));
                } else {
                    configStore.updateGroup(gid, { [field]: op.value });
                    touched.add(gid);
                }
            } else {
                rejected.push(reject(item, 'not writable'));
            }
        }
        if (order.size > 0) {
            const ids = configStore
                .getAllGroups()
                .map((g) => ({ id: g.id as string, sort: order.get(g.id as string) ?? (g.sort_order as number) }))
                .sort((a, b) => a.sort - b.sort)
                .map((g) => g.id);
            configStore.reorderGroups(ids);
            ids.forEach((id) => touched.add(id));
        }
        const rows = tree.groups();
        publisher.publish(
            [...touched].map((gid) => ({ op: 'add' as const, path: joinPath(['groups', gid]), value: rows[gid] })),
        );
        return rejected;
    }

    /** Engines in a deleted group move to 'ungrouped' (the repository does it). */
    private deleteGroup(gid: string): void {
        const { configStore, publisher } = this.d;
        const members = configStore.getAllEngines().filter((e) => e.group_id === gid);
        configStore.deleteGroup(gid);
        publisher.publish([{ op: 'remove', path: joinPath(['groups', gid]) }]);
        for (const e of members) publisher.info(e.engine_id as string);
    }

    /** Listener rebind first, persist only on success (issue #692). */
    private async settings(group: WriteItem[]): Promise<WriteRejection[]> {
        const { configStore, engineManager, publisher } = this.d;
        const rejected: WriteRejection[] = [];
        for (const item of group) {
            const parsed = ManagerSettingsSchema.safeParse({ dgramListeners: item.op.value });
            if (item.op.path !== '/settings/dgramListeners' || item.op.op !== 'replace' || !parsed.success) {
                rejected.push(reject(item, 'invalid listeners'));
                continue;
            }
            try {
                await engineManager.setListeners(parsed.data.dgramListeners);
            } catch (err) {
                rejected.push(reject(item, `Could not bind listeners: ${(err as Error).message}`));
                continue;
            }
            configStore.setDgramListeners(parsed.data.dgramListeners);
            publisher.publish([{ op: 'replace', path: '/settings/dgramListeners', value: engineManager.dgramListeners }]);
        }
        return rejected;
    }
}
