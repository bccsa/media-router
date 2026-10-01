<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { DashboardAction } from '@media-router/shared-types';
import MrSelect from '@/components/common/MrSelect.vue';
import MrInput from '@/components/common/MrInput.vue';
import MrToggle from '@/components/common/MrToggle.vue';
import MrButton from '@/components/common/MrButton.vue';
import ValuePicker from './ValuePicker.vue';
import { useModules } from './useModules';
import { useSubscription, useValue } from '../useValue';
import { useRouters } from '../useRouters';
import type { ValueEntry } from '../entries';
import type { DashboardSource } from '../source';
import { moduleIdOf, routerOf } from '../paths';
import { actionKind } from '../scriptText';
import { isScalar } from '../valueTypes';

type Kind = NonNullable<ReturnType<typeof actionKind>>;

const props = defineProps<{ source: DashboardSource; action?: DashboardAction; pickRouter?: boolean }>();
/** `confirm` = what "Ask to confirm" should default to for this action. */
const emit = defineEmits<{ update: [action: DashboardAction | undefined, confirm: boolean] }>();

const KINDS = [
    { value: 'restart', label: 'Restart a module' },
    { value: 'start', label: 'Start the router' },
    { value: 'stop', label: 'Stop the router' },
    { value: 'reset', label: 'Reset the router (audio + all modules)' },
    { value: 'reboot', label: 'Reboot the router' },
    { value: 'set', label: 'Set a value' },
];

const path = computed(() => props.action?.path ?? '');
const router = ref<string | null>(routerOf(path.value) ?? null);
const base = computed(() => (!props.pickRouter ? '' : router.value ? `/engines/${router.value}` : null));

const kind = computed(() => actionKind(props.action));

const { options: routers } = useRouters(props.source, () => !!props.pickRouter);
const modules = useModules(props.source, () => base.value);
const moduleOptions = computed(() => modules.value.map((m) => ({ value: m.id, label: m.name })));
const moduleId = computed(() => (kind.value === 'restart' ? (moduleIdOf(path.value) ?? '') : ''));

// A "set" action's target, for its type and choices.
const target = useValue(props.source, () => (kind.value === 'set' && path.value ? path.value : undefined), () => false);
const picking = ref(false);

function setKind(k: string) {
    const b = base.value ?? '';
    if (k === 'start' || k === 'stop') emit('update', { kind: 'write', path: `${b}/info/running`, value: k === 'start' }, k === 'stop');
    else if (k === 'reboot' || k === 'reset') emit('update', base.value === null ? undefined : { kind: 'call', path: b || '/', method: k }, true);
    else if (k === 'restart') emit('update', undefined, true);
    else emit('update', undefined, false);
    pendingKind.value = k as Kind;
}
const pendingKind = ref<Kind | undefined>(kind.value);
const shownKind = computed(() => kind.value ?? pendingKind.value);
// Router-wide actions follow a change of router.
watch(router, () => {
    const k = shownKind.value;
    if (k === 'start' || k === 'stop' || k === 'reset' || k === 'reboot') setKind(k);
});

function setModule(id: string) {
    emit('update', { kind: 'call', path: `${base.value ?? ''}/modules/${id}`, method: 'restart' }, true);
}

function pickTarget(e: ValueEntry) {
    picking.value = false;
    const d = e.desc;
    const value = d.type === 'boolean' ? true : d.enum?.[0] ?? (typeof d.min === 'number' ? d.min : d.type === 'string' ? '' : 0);
    emit('update', { kind: 'write', path: e.path, value }, false);
}

function setValue(v: unknown) {
    if (props.action?.kind !== 'write') return;
    const d = target.desc.value;
    let value = v;
    if (d?.enum) value = d.enum.find((e) => String(e) === String(v)) ?? v;
    else if (d?.type === 'number' || d?.type === 'integer') value = Number(v);
    emit('update', { ...props.action, value }, false);
}

const accept = (e: ValueEntry) => e.desc.access === 'write' && e.kind !== 'vu' && isScalar(e.desc);
const enumOptions = computed(() => (target.desc.value?.enum ?? []).map((v) => ({ value: String(v), label: target.desc.value?.enumLabels?.[String(v)] ?? String(v) })));
</script>

<template>
    <div class="space-y-2">
        <MrSelect
            v-if="pickRouter"
            :model-value="router ?? ''"
            label="Router"
            :options="routers"
            placeholder="Choose a router"
            @update:model-value="(v) => (router = String(v))"
        />
        <MrSelect :model-value="shownKind ?? ''" label="Action" :options="KINDS" placeholder="Choose an action" @update:model-value="(v) => setKind(String(v))" />
        <MrSelect
            v-if="shownKind === 'restart'"
            :model-value="moduleId"
            label="Module"
            :options="moduleOptions"
            searchable
            placeholder="Choose a module"
            @update:model-value="(v) => setModule(String(v))"
        />
        <template v-if="shownKind === 'set'">
            <div class="flex items-center gap-2">
                <span class="text-xs text-subtle truncate flex-1">{{ action?.path ?? 'No value chosen' }}</span>
                <MrButton size="sm" variant="secondary" @click="picking = true">Choose value…</MrButton>
            </div>
            <template v-if="action?.kind === 'write'">
                <MrToggle v-if="target.desc.value?.type === 'boolean'" :model-value="action.value === true" label="Set to" @update:model-value="setValue" />
                <MrSelect v-else-if="enumOptions.length" :model-value="String(action.value)" label="Set to" :options="enumOptions" @update:model-value="setValue" />
                <MrInput
                    v-else
                    :model-value="action.value as string | number"
                    label="Set to"
                    :type="target.desc.value?.type === 'string' ? 'text' : 'number'"
                    @update:model-value="setValue"
                />
            </template>
        </template>
        <ValuePicker v-if="picking" :source="source" :accept="accept" :pick-router="pickRouter" title="Value to set" @pick="pickTarget" @close="picking = false" />
    </div>
</template>
