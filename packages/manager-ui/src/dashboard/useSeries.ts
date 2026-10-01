// A multi-value widget's values with their labels and live state.
import { computed, type ComputedRef } from 'vue';
import { useSubscription, useValues, type ValueSnapshot } from './useValue';
import { lastSegment, moduleOf, namePathOf, onlinePathOf, routerOf } from './paths';
import type { SeriesValue } from './registry';
import type { DashboardSource } from './source';
import { routerIsDown } from './useRouterDown';

/**
 * A multi-value widget's values (a trend), each labelled "router · module ·
 * value" (the router only when they span several); each value's own router may be down.
 */
export function useSeries(
    source: DashboardSource,
    rels: () => string[],
    offline: () => boolean,
): { multi: ComputedRef<ValueSnapshot[]>; series: ComputedRef<SeriesValue[]> } {
    const multi = useValues(source, rels, (p) => offline() || routerIsDown(source, p));
    const routerIds = computed(() => [...new Set(multi.value.map((s) => routerOf(s.path)).filter((id): id is string => !!id))]);
    const several = computed(() => routerIds.value.length > 1);
    useSubscription(source, () => [
        ...new Set(
            multi.value.flatMap((s) => {
                const mod = moduleOf(s.path);
                return [onlinePathOf(s.path), mod && mod !== s.path ? `${mod}/displayName` : undefined].filter((x): x is string => !!x);
            }),
        ),
        ...(several.value ? routerIds.value.map(namePathOf) : []),
    ]);
    const series = computed<SeriesValue[]>(() =>
        multi.value.map((s) => {
            const mod = moduleOf(s.path);
            const router = several.value ? routerOf(s.path) : undefined;
            const parts = [
                router && (source.get<string>(namePathOf(router)) || router),
                mod && mod !== s.path && source.get<string>(`${mod}/displayName`),
                s.desc?.label || lastSegment(s.path),
            ].filter(Boolean);
            return { path: s.path, label: parts.join(' · '), value: s.value, desc: s.desc, live: s.state === 'ok' && source.connected.value };
        }),
    );
    return { multi, series };
}
