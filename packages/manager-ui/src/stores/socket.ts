import { defineStore } from 'pinia';
import { ref, readonly } from 'vue';
// shared-types is CJS: named imports break under Vite's interop (see stores/engines.ts).
import * as shared from '@media-router/shared-types';
import type { PatchOp, WriteResult } from '@media-router/shared-types';
import { TreeClient } from '@/tree/TreeClient';
import { applyRenamed, applyTreeOps, dropUncovered } from '@/tree/mirror';

const { splitPath } = shared;

/**
 * The manager connection: one tree client (ADR-0024) feeding the Pinia
 * stores. Components subscribe to what they show (`useTopics`), write by
 * tree path and `call` actions.
 */
export const useSocketStore = defineStore('socket', () => {
    const connected = ref(false);
    /** Latest failed host reboot (typically a polkit denial), until shown. */
    const rebootFailure = ref<{ engineId: string; reason: string } | null>(null);
    let client: TreeClient | null = null;

    function ensureClient(): TreeClient {
        if (client) return client;
        client = new TreeClient({
            onOps: (ops) =>
                applyTreeOps(ops, {
                    onRebootFailed: (engineId, reason) => (rebootFailure.value = { engineId, reason }),
                }),
            onDropped: dropUncovered,
            onRenamed: (r) => {
                applyRenamed(r);
                const oldId = splitPath(r.from)[1];
                if (rebootFailure.value?.engineId === oldId) {
                    rebootFailure.value = { ...rebootFailure.value, engineId: splitPath(r.to)[1] };
                }
            },
            onConnected: (c) => (connected.value = c),
        });
        client.connect();
        return client;
    }

    /** Idempotent: children may subscribe before App mounts. */
    function connect() {
        ensureClient();
    }

    function disconnect() {
        client?.disconnect();
        client = null;
        connected.value = false;
    }

    /** Keep `patterns` subscribed until the returned function is called. */
    function subscribe(patterns: string[]): () => void {
        return ensureClient().subscribe(patterns);
    }

    function write(ops: PatchOp[]): Promise<WriteResult> {
        return ensureClient().write(ops);
    }

    /** `write`, failing with the first rejection's reason. */
    async function writeOrThrow(ops: PatchOp[]): Promise<void> {
        const { rejected } = await write(ops);
        if (rejected.length > 0) throw new Error(rejected[0].reason);
    }

    function call<T = unknown>(path: string, method: string, args?: unknown, opts?: { timeoutMs?: number }): Promise<T> {
        return ensureClient().call<T>(path, method, args, opts?.timeoutMs);
    }

    function clearRebootFailure() {
        rebootFailure.value = null;
    }

    return {
        connected: readonly(connected),
        rebootFailure: readonly(rebootFailure),
        clearRebootFailure,
        connect,
        disconnect,
        subscribe,
        write,
        writeOrThrow,
        call,
    };
});
