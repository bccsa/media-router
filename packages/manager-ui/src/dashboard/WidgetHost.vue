<script setup lang="ts">
import { computed } from 'vue';
import { Lock } from 'lucide-vue-next';
import type { DashboardWidget } from '@media-router/shared-types';
import * as wire from '@media-router/shared-types/browser';
import { WIDGETS, optionsOf } from './registry';
import { useValue } from './useValue';
import { useRouterDown } from './useRouterDown';
import { useSeries } from './useSeries';
import { lastSegment } from './paths';
import { useFlash, useWidgetAction } from './useWidgetAction';
import type { DashboardSource } from './source';

// shared-types is CJS: named imports break under Vite's interop (see stores/engines.ts).
const { absolutePath, widgetPaths } = wire;

const props = defineProps<{
    widget: DashboardWidget;
    source: DashboardSource;
    /** The router behind the source is known to be down. */
    offline: boolean;
    /** In the editor: no input. */
    editing?: boolean;
    rect: { left: number; top: number; width: number; height: number };
}>();

const def = computed(() => WIDGETS[props.widget.type]);
const options = computed(() => optionsOf(def.value, props.widget));
// The widget's router: its value's, else its first action's (`/` is the router itself).
const routerDown = useRouterDown(props.source, () => {
    const first = def.value?.binds === 'value' ? props.widget.bind : widgetPaths(props.widget)[0];
    return first === undefined ? undefined : absolutePath(props.source.prefix, first);
});
const binding = useValue(
    props.source,
    () => (def.value?.binds === 'value' ? props.widget.bind : undefined),
    () => props.offline || routerDown.value,
);
const live = computed(() => props.source.connected.value && !props.offline && !routerDown.value);

const { multi, series } = useSeries(
    props.source,
    () => (def.value?.binds === 'values' ? (props.widget.binds ?? []) : []),
    () => props.offline,
);

const label = computed(
    () => options.value.label || binding.desc.value?.label || lastSegment(props.widget.bind) || def.value?.label || props.widget.type,
);

const state = computed(() => {
    if (def.value?.binds === 'value') return binding.state.value;
    if (def.value?.binds === 'values') {
        if (multi.value.length === 0) return 'unbound';
        return multi.value.every((s) => s.state === 'missing') ? 'missing' : multi.value.some((s) => s.state === 'ok') ? 'ok' : 'stale';
    }
    return def.value?.binds === 'action' && !live.value ? 'stale' : 'ok';
});

const interactive = computed(() => {
    const d = def.value;
    if (props.editing || props.widget.inputDisabled || !d) return false;
    if (d.binds === 'action') return live.value && (!!props.widget.action || !!props.widget.script);
    return !!d.control && binding.state.value === 'ok' && binding.desc.value?.access === 'write';
});

// A control that takes no input (disabled, or a read-only value) says so,
// so it does not look broken; missing/stale have their own flags.
const locked = computed(() => {
    const d = def.value;
    if (props.editing || !d || interactive.value || state.value !== 'ok') return false;
    return !!d.control || d.binds === 'action';
});

const { on: rejected, flash } = useFlash();

async function write(value: unknown) {
    const path = binding.path.value;
    if (!path || !interactive.value) return;
    try {
        const r = await props.source.write([{ op: 'replace', path, value }]);
        if (r.rejected.length > 0) flash();
    } catch {
        flash();
    }
}

const { busy, progress, failure, press } = useWidgetAction({
    source: props.source,
    widget: () => props.widget,
    interactive: () => interactive.value,
    confirmTitle: () => (options.value.confirm ? `${options.value.text || label.value}?` : undefined),
    flash,
});

const style = computed(() => {
    const o = options.value;
    return {
        left: `${props.rect.left}px`,
        top: `${props.rect.top}px`,
        width: `${props.rect.width}px`,
        height: `${props.rect.height}px`,
        // No size set: each widget keeps its own. Bold as the option says (a kind's default included).
        '--dw-label-size': typeof o.labelSize === 'number' && o.labelSize > 0 ? `${o.labelSize}px` : undefined,
        '--dw-label-weight': o.labelBold ? 700 : 400,
    };
});
</script>

<template>
    <div class="dw" :class="[`state-${state}`, { 'dw-bare': def?.bare, 'dw-rejected': rejected, 'dw-locked': locked }]" :style="style">
        <div class="dw-body">
            <component
                :is="def.component"
                v-if="def"
                :widget="widget"
                :value="binding.value.value"
                :desc="binding.desc.value"
                :interactive="interactive"
                :label="label"
                :options="options"
                v-bind="{ ...def.componentProps, ...(def.binds === 'action' ? { busy, progress, failure } : def.binds === 'values' ? { series } : {}) }"
                @write="write"
                @action="press"
            />
            <div v-else class="dw-label">Unknown widget “{{ widget.type }}”</div>
            <Lock v-if="locked" class="dw-lock" :size="12" aria-label="Display only" />
            <div v-if="state === 'missing'" class="dw-flag">Missing</div>
            <div v-else-if="state === 'stale'" class="dw-flag">Stale</div>
        </div>
    </div>
</template>
