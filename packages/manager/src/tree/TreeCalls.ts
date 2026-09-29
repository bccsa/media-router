import { z } from 'zod';
import { CreateEngineSchema, EngineIdSchema, createLogger, splitPath } from '@media-router/shared-types';
import { TreeCallError, type TreeCaller } from '@media-router/topic-tree';
import type { ConfigStore } from '../config/ConfigStore.js';
import type { EngineConnectionManager } from '../engines/EngineConnectionManager.js';
import type { PluginUploadService } from '../services/PluginUploadService.js';
import type { RuntimeCache } from './RuntimeCache.js';
import type { TreePublisher } from './TreePublisher.js';

const log = createLogger('TreeCalls');

const SetPassword = z.object({ password: z.string().min(1) });
const Rename = z.object({ newEngineId: EngineIdSchema });
const Rollback = z.object({ versionId: z.number().int().positive() });
const Upload = z.object({ moduleId: z.string().min(1), filename: z.string().min(1), bytes: z.instanceof(Buffer) });
const ReadUpload = z.object({ filename: z.string().min(1) });

export interface TreeCallsDeps {
    configStore: ConfigStore;
    engineManager: EngineConnectionManager;
    runtime: RuntimeCache;
    publisher: TreePublisher;
    pluginUploads: PluginUploadService;
}

function args<T>(schema: z.ZodType<T>, raw: unknown): T {
    const parsed = schema.safeParse(raw ?? {});
    if (!parsed.success) throw new TreeCallError('invalid arguments');
    return parsed.data;
}

/** Actions, secrets, binary and bulky lookups: `call` on a tree node (ADR-0024). */
export class TreeCalls {
    constructor(private readonly d: TreeCallsDeps) {}

    handle(_caller: TreeCaller, path: string, method: string, raw: unknown): unknown {
        const [root, id, branch, sub] = splitPath(path);
        if (root === 'engines' && id === undefined && method === 'create') return this.createEngine(raw);
        if (root === 'engines' && id !== undefined) {
            this.requireEngine(id);
            if (branch === undefined) return this.engineCall(id, method, raw);
            if (branch === 'modules' && sub !== undefined && method === 'restart') {
                return this.command(id, { command: 'moduleRestart', moduleId: sub });
            }
            if (branch === 'profiles' && sub !== undefined) return this.profileCall(id, sub, method, raw);
        }
        if (root === 'plugins' && id !== undefined) return this.pluginCall(id, method, raw);
        throw new TreeCallError(`no method ${method} on ${path}`);
    }

    private requireEngine(engineId: string): Record<string, unknown> {
        const engine = this.d.configStore.getEngine(engineId);
        if (!engine) throw new TreeCallError('Engine not found');
        return engine;
    }

    private createEngine(raw: unknown): { id: string } {
        const { engineId, displayName, password } = args(CreateEngineSchema, raw);
        const { configStore, engineManager, publisher } = this.d;
        if (configStore.getEngine(engineId)) throw new TreeCallError('Engine ID already exists');
        configStore.createEngine(engineId, displayName, password);
        configStore.createProfile(engineId, 'default', {});
        configStore.setActiveProfile(engineId, 'default');
        engineManager.refreshEncryptionKeys();
        publisher.info(engineId);
        return { id: engineId };
    }

    private engineCall(engineId: string, method: string, raw: unknown): unknown {
        const { configStore, engineManager } = this.d;
        switch (method) {
            case 'setPassword': {
                const { password } = args(SetPassword, raw);
                const engine = this.requireEngine(engineId);
                configStore.updateEngine(engineId, engine.display_name as string, password);
                engineManager.refreshEncryptionKeys();
                return {};
            }
            case 'rename':
                return this.rename(engineId, args(Rename, raw).newEngineId);
            case 'reset':
            case 'reboot':
                return this.command(engineId, { command: method });
            default:
                throw new TreeCallError(`no method ${method} on an engine`);
        }
    }

    /**
     * Re-key the engine. Order matters: caches and subscriptions move before
     * the old session is destroyed, whose offline event then finds nothing.
     */
    private rename(oldId: string, newId: string): { id: string } {
        const { configStore, engineManager, runtime, publisher } = this.d;
        if (oldId === newId) return { id: newId };
        if (configStore.getEngine(newId)) throw new TreeCallError('Engine ID already exists');
        try {
            configStore.renameEngine(oldId, newId);
        } catch (err) {
            log.error({ err, oldId, newId }, 'Engine rename failed');
            throw new TreeCallError('Failed to rename engine');
        }
        runtime.rename(oldId, newId);
        publisher.renamed(oldId, newId);
        engineManager.notifyRename(oldId, newId);
        engineManager.refreshEncryptionKeys();
        return { id: newId };
    }

    private command(engineId: string, command: Record<string, unknown>): Record<string, never> {
        const { engineManager } = this.d;
        if (!engineManager.isEngineOnline(engineId)) throw new TreeCallError('Engine is offline');
        engineManager.sendToEngine(engineId, 'command', command, { guaranteeDelivery: true });
        return {};
    }

    private profileCall(engineId: string, name: string, method: string, raw: unknown): unknown {
        const { configStore } = this.d;
        switch (method) {
            case 'config': {
                const config = configStore.getProfile(engineId, name);
                if (!config) throw new TreeCallError('Profile not found');
                return config;
            }
            case 'history':
                return configStore.getVersionHistory(engineId, name);
            case 'rollback': {
                const version = configStore.getVersion(engineId, name, args(Rollback, raw).versionId);
                if (!version) throw new TreeCallError('Version not found');
                configStore.updateProfileConfig(engineId, name, version);
                return {};
            }
            default:
                throw new TreeCallError(`no method ${method} on a profile`);
        }
    }

    private pluginCall(pluginId: string, method: string, raw: unknown): unknown {
        const { pluginUploads } = this.d;
        try {
            if (method === 'upload') return pluginUploads.save({ pluginId, ...args(Upload, raw) });
            if (method === 'readUpload') return pluginUploads.read(pluginId, args(ReadUpload, raw).filename);
        } catch (err) {
            if (err instanceof TreeCallError) throw err;
            throw new TreeCallError((err as Error).message);
        }
        throw new TreeCallError(`no method ${method} on a plugin`);
    }
}
