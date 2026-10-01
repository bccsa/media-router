import { computed, onUnmounted, watch, type ComputedRef } from 'vue';
import type { ValueDescriptor } from '@media-router/shared-types';
import { builtinDescriptor } from './entries';
import type { DashboardSource } from './source';
import { moduleOf } from './paths';

/**
 * What a widget can show: `ok`; `loading` until the first snapshot; `stale`
 * (last value, link or router down); `missing` (the value no longer exists).
 */
export type BindState = 'unbound' | 'loading' | 'ok' | 'stale' | 'missing';

export interface Binding {
    path: ComputedRef<string | undefined>;
    value: ComputedRef<unknown>;
    desc: ComputedRef<ValueDescriptor | undefined>;
    state: ComputedRef<BindState>;
}

/** Keep a subscription to `patterns` while the component lives, following changes. */
export function useSubscription(source: DashboardSource, patterns: () => string[]): void {
    let release: (() => void) | null = null;
    watch(
        patterns,
        (next) => {
            const previous = release;
            release = next.length > 0 ? source.subscribe(next) : null;
            previous?.();
        },
        { immediate: true, deep: true },
    );
    onUnmounted(() => release?.());
}

/**
 * One widget's value (router-relative `rel`, or absolute on a manager
 * dashboard) with its `/meta` descriptor. `offline` = the router behind the
 * source is known to be down.
 */
export function useValue(source: DashboardSource, rel: () => string | undefined, offline: () => boolean): Binding {
    const path = computed(() => {
        const r = rel();
        return r === undefined ? undefined : source.prefix + r;
    });
    useSubscription(source, () => (path.value ? patternsFor(path.value) : []));
    const snap = computed(() => (path.value ? snapshot(source, path.value, offline()) : undefined));
    return {
        path,
        value: computed(() => snap.value?.value),
        desc: computed(() => snap.value?.desc),
        state: computed<BindState>(() => snap.value?.state ?? 'unbound'),
    };
}

export interface ValueSnapshot {
    path: string;
    value: unknown;
    desc: ValueDescriptor | undefined;
    state: BindState;
}

/** Several values at once (a trend), each as `useValue` sees it; `offline(path)` per value's router. */
export function useValues(source: DashboardSource, rels: () => string[], offline: (path: string) => boolean): ComputedRef<ValueSnapshot[]> {
    const paths = computed(() => rels().map((r) => source.prefix + r));
    useSubscription(source, () => paths.value.flatMap(patternsFor));
    return computed(() => paths.value.map((p) => snapshot(source, p, offline(p))));
}

// A module value is missing only when its module is: levels or a status
// field may simply not be reported yet. `pluginId` is the cheap probe.
function probeOf(path: string): string | undefined {
    const mod = moduleOf(path);
    return mod && mod !== path ? `${mod}/pluginId` : undefined;
}

function patternsFor(path: string): string[] {
    const probe = probeOf(path);
    return [path, `/meta${path}`, ...(probe ? [probe] : [])];
}

function snapshot(source: DashboardSource, path: string, offline: boolean): ValueSnapshot {
    const probe = probeOf(path);
    const value = source.get(path);
    const meta = source.get<ValueDescriptor>(`/meta${path}`);
    const desc = meta ?? builtinDescriptor(path);
    const exists = probe ? source.get(probe) !== undefined : false;
    const known = value !== undefined || meta !== undefined || exists;
    const loaded = source.loaded(path) && (!probe || source.loaded(probe));
    let state: BindState;
    // A router known to be down is stale even when it took its values with it.
    if (offline) state = 'stale';
    else if (!source.connected.value) state = known ? 'stale' : 'loading';
    else if (!loaded) state = known ? 'ok' : 'loading';
    else state = known ? 'ok' : 'missing';
    return { path, value, desc, state };
}
