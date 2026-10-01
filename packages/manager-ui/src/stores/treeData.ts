import { defineStore } from 'pinia';
import { ref } from 'vue';
import * as shared from '@media-router/shared-types';
import type { PatchOp } from '@media-router/shared-types';

const { applyTreeOp, joinPath } = shared;

type Branch = 'settings' | 'plugins';

/**
 * Small manager-level branches of the tree: `/settings` and the `/plugins`
 * catalog. Filled only while a component subscribes to them.
 */
export const useTreeDataStore = defineStore('treeData', () => {
    const settings = ref<Record<string, unknown>>({});
    const plugins = ref<Record<string, Record<string, unknown>>>({});

    function apply(segments: string[], op: PatchOp) {
        const target = segments[0] === 'settings' ? settings : plugins;
        if (segments.length === 1) {
            target.value = op.op === 'remove' ? {} : ((op.value as Record<string, any>) ?? {});
            return;
        }
        const next = JSON.parse(JSON.stringify(target.value));
        applyTreeOp(next, { ...op, path: joinPath(segments.slice(1)) });
        target.value = next;
    }

    function drop(branch: Branch) {
        if (branch === 'settings') settings.value = {};
        else plugins.value = {};
    }

    return { settings, plugins, apply, drop };
});
