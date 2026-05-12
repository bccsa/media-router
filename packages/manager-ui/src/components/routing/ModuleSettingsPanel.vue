<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import MrButton from '@/components/common/MrButton.vue';
import MrInput from '@/components/common/MrInput.vue';
import MrSelect from '@/components/common/MrSelect.vue';
import MrSlider from '@/components/common/MrSlider.vue';
import MrToggle from '@/components/common/MrToggle.vue';
import MrArrayField from '@/components/common/MrArrayField.vue';
import { useEngineStore } from '@/stores/engines';
import { useSocketStore } from '@/stores/socket';
import { useDeviceStore } from '@/stores/devices';
import { patch } from '@/composables/usePatch';

const props = defineProps<{ engineId: string; moduleId: string }>();
const emit = defineEmits<{ close: [] }>();

// Close panel on Escape key
function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') emit('close');
}
onMounted(() => document.addEventListener('keydown', onKeydown));
onUnmounted(() => document.removeEventListener('keydown', onKeydown));

const engineStore = useEngineStore();
const socket = useSocketStore();
const deviceStore = useDeviceStore();

const module = computed(() => engineStore.getEngine(props.engineId)?.modules[props.moduleId]);

// Rename
const editName = ref('');
watch(
    () => module.value?.displayName,
    (name) => {
        if (name) editName.value = name;
    },
    { immediate: true },
);
// Reset name when switching modules
watch(
    () => props.moduleId,
    () => {
        editName.value = module.value?.displayName ?? '';
    },
);

function saveName() {
    const trimmed = editName.value.trim();
    if (trimmed && trimmed !== module.value?.displayName) {
        patch.moduleRename(props.engineId, props.moduleId, trimmed);
    }
}

interface FormField {
    key: string;
    type: string;
    label: string;
    description: string;
    defaultValue: unknown;
    enumValues?: unknown[];
    enumLabels?: Record<string, string>; // value → display label
    liveUpdatable: boolean;
    deviceType?: string; // e.g. 'audio-source', 'audio-sink', 'video', 'drm-connector'
    widget?: string; // 'slider' etc.
    minimum?: number;
    maximum?: number;
    step?: number;
    maxFrom?: string; // key of another setting that controls slider max
    enumBy?: { field: string; map: Record<string, unknown[]> }; // field value → valid enum values
    maxBy?: { field: string; map: Record<string, number> }; // field value → max for number fields
    readOnly?: boolean; // x-readOnly — show value but greyed out
    items?: { type?: string; properties?: Record<string, unknown> }; // array item schema
    showWhen?: string; // x-showWhen — "key=value" conditional visibility
    unit?: string; // x-unit — label shown after the value (e.g. "kbps", "%")
    debounceMs?: number; // x-debounceMs — debounce slow slider updates (overrides the default 50ms throttle)
}

// Device lists come from `useDeviceStore`, populated live via socket push.
// This panel does one HTTP snapshot per required type on open so dropdowns
// render without waiting for the first push.

const requiredDeviceTypes = computed<string[]>(() => {
    const schema = module.value?.configSchema as { properties?: Record<string, SchemaProperty> } | undefined;
    if (!schema?.properties) return [];
    const types = new Set<string>();
    for (const prop of Object.values(schema.properties)) {
        if (prop['x-deviceType']) types.add(prop['x-deviceType']);
    }
    return Array.from(types);
});

const fetchedKeys = new Set<string>();

async function fetchSnapshot(type: string) {
    const cacheKey = `${props.engineId}::${type}`;
    if (fetchedKeys.has(cacheKey)) return;
    fetchedKeys.add(cacheKey);
    try {
        const res = await fetch(
            `/api/v1/engines/${props.engineId}/system/devices/${encodeURIComponent(type)}`,
        );
        if (res.ok) deviceStore.set(props.engineId, type, await res.json());
    } catch (err) {
        console.warn('[ModuleSettings] Failed to load device list', type, err);
        fetchedKeys.delete(cacheKey); // retry on next change
    }
}

// Re-run whenever the set of required types changes — covers both initial
// mount (configSchema arrives async over the wire) and module switching.
// The cache key includes engineId, so switching engines auto-fetches without
// a separate watcher.
watch(
    requiredDeviceTypes,
    (types) => {
        for (const type of types) fetchSnapshot(type);
    },
    { immediate: true },
);

/** Build device dropdown options. If the currently selected device was unplugged,
 *  keep it in the list greyed out so config survives unplug/replug cycles. */
function deviceOptions(fieldKey: string, type: string) {
    const available = deviceStore.get(props.engineId, type);
    const options = available.map((d) => ({
        value: d.name,
        label: d.label,
    }));

    const selected = localSettings.value[fieldKey] as string | undefined;
    if (selected && !available.some((d) => d.name === selected)) {
        options.push({ value: selected, label: `${selected} (Disconnected)` });
    }

    return [{ value: '', label: 'No device selected' }, ...options];
}

/** JSON Schema property shape with media-router extensions. */
interface SchemaProperty {
    type?: string;
    description?: string;
    default?: unknown;
    enum?: unknown[];
    minimum?: number;
    maximum?: number;
    'x-live'?: boolean;
    'x-liveUpdatable'?: boolean;
    'x-deviceType'?: string;
    'x-widget'?: string;
    'x-step'?: number;
    'x-maxFrom'?: string;
    'x-enumBy'?: { field: string; map: Record<string, unknown[]> };
    'x-enumLabels'?: Record<string, string>;
    'x-maxBy'?: { field: string; map: Record<string, number> };
    'x-readOnly'?: boolean;
    'x-showWhen'?: string;
    'x-unit'?: string;
    'x-debounceMs'?: number;
    items?: { type?: string; properties?: Record<string, unknown> };
}

const formFields = computed<FormField[]>(() => {
    const schema = module.value?.configSchema;
    if (!schema?.properties) return [];
    const schemaProps = schema.properties as Record<string, SchemaProperty>;
    // Plugins may narrow the live set based on current config (e.g. video
    // encoder drops `bitrate` for AV1). Prefer the runtime list; fall back
    // to the schema flag when the engine hasn't reported one yet.
    const runtimeLive = module.value?.liveUpdatableParams;
    return Object.entries(schemaProps).map(([key, prop]) => ({
        key,
        type: prop.type ?? 'string',
        label: key.replace(/([A-Z])/g, ' $1').replace(/^./, (s: string) => s.toUpperCase()),
        description: prop.description ?? '',
        defaultValue: prop.default,
        enumValues: prop.enum,
        enumLabels: prop['x-enumLabels'],
        liveUpdatable: runtimeLive
            ? runtimeLive.includes(key)
            : !!prop['x-live'] || !!prop['x-liveUpdatable'],
        deviceType: prop['x-deviceType'],
        widget: prop['x-widget'],
        minimum: prop.minimum,
        maximum: prop.maximum,
        step: prop['x-step'],
        maxFrom: prop['x-maxFrom'],
        enumBy: prop['x-enumBy'],
        maxBy: prop['x-maxBy'],
        readOnly: !!prop['x-readOnly'],
        showWhen: prop['x-showWhen'],
        unit: prop['x-unit'],
        debounceMs: prop['x-debounceMs'],
        items: prop.items as FormField['items'],
    }));
});

/** Check if a field should be visible based on x-showWhen condition ("key=value"). */
function isFieldVisible(field: FormField): boolean {
    if (!field.showWhen) return true;
    const [key, value] = field.showWhen.split('=');
    return String(localSettings.value[key] ?? '') === value;
}

/** Resolve effective enum values for a field — checks x-enumBy first. */
function getFieldEnum(field: FormField): unknown[] | undefined {
    if (field.enumBy) {
        const val = String(localSettings.value[field.enumBy.field] ?? '');
        return field.enumBy.map[val] ?? field.enumValues;
    }
    return field.enumValues;
}

/** Resolve effective maximum for a number field — checks x-maxBy first. */
function getFieldMax(field: FormField): number | undefined {
    if (field.maxBy) {
        const val = String(localSettings.value[field.maxBy.field] ?? '');
        return field.maxBy.map[val] ?? field.maximum;
    }
    return field.maximum;
}

const localSettings = ref<Record<string, unknown>>({});

watch(
    () => module.value?.settings,
    (settings) => {
        if (!settings) return;
        const defaults: Record<string, unknown> = {};
        for (const f of formFields.value) {
            if (f.defaultValue !== undefined) defaults[f.key] = f.defaultValue;
        }
        localSettings.value = { ...defaults, ...settings };
    },
    { immediate: true, deep: true },
);

// Live updates use one of two strategies per field:
//   * throttle (default 50ms): fire first update immediately, coalesce the
//     rest, flush once the window closes. Good for volume / fast interactive
//     sliders where the backend takes updates cheaply.
//   * debounce (opt-in via `x-debounceMs`): only fire after the user has
//     stopped changing the value for N ms. Good for expensive sliders
//     (video bitrate: the encoder needs to reconfigure on each change).
const DEFAULT_THROTTLE_MS = 50;
let throttleTimer: ReturnType<typeof setTimeout> | null = null;
let throttlePending: { key: string; value: unknown } | null = null;
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

onUnmounted(() => {
    if (throttleTimer) {
        clearTimeout(throttleTimer);
        throttleTimer = null;
    }
    if (throttlePending) {
        sendLiveUpdate(throttlePending.key, throttlePending.value);
        throttlePending = null;
    }
    // Flush any pending debounced values on unmount so the user doesn't lose
    // changes they made right before closing the panel.
    for (const [key, timer] of debounceTimers) {
        clearTimeout(timer);
        sendLiveUpdate(key, localSettings.value[key]);
    }
    debounceTimers.clear();
});

function sendLiveUpdate(key: string, value: unknown) {
    patch.moduleSetting(props.engineId, props.moduleId, key, value);
}

function updateSetting(key: string, value: unknown) {
    localSettings.value = { ...localSettings.value, [key]: value };
    // Clamp dependent fields when a controlling field changes (e.g. codec → channels max)
    for (const f of formFields.value) {
        if (!f.maxBy) continue;
        const max = getFieldMax(f);
        const cur = Number(localSettings.value[f.key] ?? 0);
        if (max != null && cur > max) {
            localSettings.value = { ...localSettings.value, [f.key]: max };
        }
    }
    const field = formFields.value.find((f) => f.key === key);
    if (!field?.liveUpdatable) return;

    if (field.debounceMs && field.debounceMs > 0) {
        const existing = debounceTimers.get(key);
        if (existing) clearTimeout(existing);
        debounceTimers.set(
            key,
            setTimeout(() => {
                debounceTimers.delete(key);
                sendLiveUpdate(key, localSettings.value[key]);
            }, field.debounceMs),
        );
        return;
    }

    throttlePending = { key, value };
    if (!throttleTimer) {
        sendLiveUpdate(key, value);
        throttleTimer = setTimeout(() => {
            throttleTimer = null;
            if (throttlePending) {
                sendLiveUpdate(throttlePending.key, throttlePending.value);
                throttlePending = null;
            }
        }, DEFAULT_THROTTLE_MS);
    }
}

const isEnabled = computed(() => module.value?.enabled !== false);

function doRestart() {
    // Restart stays as a command (lifecycle operation)
    socket.emit('module:restart', { engineId: props.engineId, moduleId: props.moduleId });
}
function doToggle() {
    patch.moduleToggle(props.engineId, props.moduleId, !isEnabled.value);
}
function doClone() {
    patch.cloneModule(props.engineId, props.moduleId);
}
function doDelete() {
    if (confirm(`Delete "${module.value?.displayName}"?`)) {
        patch.removeModule(props.engineId, props.moduleId);
        emit('close');
    }
}

const saved = ref(false);

function applyAll() {
    patch.moduleSettings(props.engineId, props.moduleId, localSettings.value);
    saved.value = true;
    setTimeout(() => {
        saved.value = false;
    }, 2000);
}
</script>

<template>
    <div
        class="fixed right-0 top-12 h-[calc(100vh-3rem)] w-80 z-30 flex flex-col shadow-xl bg-card border-l border-border"
    >
        <div class="flex items-center justify-between px-4 py-3 border-b border-border">
            <input
                v-model="editName"
                class="text-sm font-semibold bg-transparent border-b outline-none flex-1 mr-2 text-foreground border-border"
                @keydown.enter="($event.target as HTMLInputElement).blur()"
                @blur="saveName"
            />
            <button @click="$emit('close')" class="p-1 rounded-md text-muted">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="2"
                        d="M6 18L18 6M6 6l12 12"
                    />
                </svg>
            </button>
        </div>

        <!-- Quick actions -->
        <div class="flex items-center justify-around px-3 py-2 border-b border-border">
            <button
                @click="doRestart"
                class="flex flex-col items-center gap-0.5 px-2 py-1 rounded-md transition-colors hover:opacity-80 text-subtle"
            >
                <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                >
                    <polyline points="23 4 23 10 17 10" />
                    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                </svg>
                <span class="text-[9px]">Restart</span>
            </button>
            <button
                @click="doToggle"
                class="flex flex-col items-center gap-0.5 px-2 py-1 rounded-md transition-colors hover:opacity-80"
                :class="isEnabled ? 'text-subtle' : 'text-ok'"
            >
                <svg
                    v-if="isEnabled"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                >
                    <path d="M18.36 6.64A9 9 0 0 1 20.77 15M2 12a10 10 0 0 0 18.77 3" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                </svg>
                <svg
                    v-else
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                >
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                <span class="text-[9px]">{{ isEnabled ? 'Disable' : 'Enable' }}</span>
            </button>
            <button
                @click="doClone"
                class="flex flex-col items-center gap-0.5 px-2 py-1 rounded-md transition-colors hover:opacity-80 text-subtle"
            >
                <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                >
                    <rect x="9" y="9" width="13" height="13" rx="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
                <span class="text-[9px]">Clone</span>
            </button>
            <button
                @click="doDelete"
                class="flex flex-col items-center gap-0.5 px-2 py-1 rounded-md transition-colors hover:opacity-80 text-error"
            >
                <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                >
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                    <path d="M10 11v6" />
                    <path d="M14 11v6" />
                    <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                </svg>
                <span class="text-[9px]">Delete</span>
            </button>
        </div>

        <div class="flex-1 overflow-y-auto p-4 space-y-4">
            <div v-if="formFields.length === 0" class="text-sm py-4 text-center text-muted">
                No configurable settings.
            </div>
            <div
                v-for="field in formFields"
                :key="field.key"
                v-show="isFieldVisible(field)"
                class="space-y-1.5"
            >
                <label class="flex items-center gap-1 text-xs font-medium text-subtle">
                    {{ field.label }}
                    <span
                        v-if="field.liveUpdatable"
                        class="text-amber-500 text-[10px] cursor-help relative group"
                        >&#9889;
                        <span
                            class="hidden group-hover:block absolute left-4 -top-1 w-40 p-2 rounded-md shadow-lg text-[9px] leading-relaxed bg-card border border-border text-foreground"
                            style="z-index: 9999"
                        >
                            Live update — changes apply instantly without restarting the module
                        </span>
                    </span>
                </label>
                <p v-if="field.description" class="text-[10px] text-muted">
                    {{ field.description }}
                </p>
                <!-- Read-only field (auto-detected values) -->
                <div
                    v-if="field.readOnly"
                    class="w-full px-2 py-1.5 text-sm rounded-md opacity-60 bg-surface-alt border border-border-alt text-muted"
                >
                    {{ localSettings[field.key] ?? '—' }}
                </div>
                <!-- Device picker (for x-deviceType fields) -->
                <template v-else>
                    <MrSelect
                        v-if="field.deviceType"
                        :model-value="(localSettings[field.key] as string) ?? ''"
                        :options="deviceOptions(field.key, field.deviceType!)"
                        @update:model-value="updateSetting(field.key, $event)"
                    />
                    <!-- Enum select (supports field-dependent options via x-enumBy) -->
                    <MrSelect
                        v-else-if="getFieldEnum(field)"
                        :model-value="localSettings[field.key] as string | number"
                        :options="
                            getFieldEnum(field)!.map((opt) => ({
                                value: (field.type === 'number' ? Number(opt) : String(opt)) as
                                    | string
                                    | number,
                                label: field.enumLabels?.[String(opt)] ?? String(opt),
                            }))
                        "
                        @update:model-value="updateSetting(field.key, $event)"
                    />
                    <!-- Array field -->
                    <MrArrayField
                        v-else-if="field.type === 'array' && field.items"
                        :model-value="
                            (localSettings[field.key] as unknown[]) ?? field.defaultValue ?? []
                        "
                        :schema="field.items"
                        :disabled="field.readOnly"
                        @update:model-value="updateSetting(field.key, $event)"
                    />
                    <!-- Boolean toggle -->
                    <MrToggle
                        v-else-if="field.type === 'boolean'"
                        :model-value="!!localSettings[field.key]"
                        @update:model-value="updateSetting(field.key, $event)"
                    />
                    <!-- Slider for volume/gain controls -->
                    <MrSlider
                        v-else-if="field.widget === 'slider'"
                        :model-value="Number(localSettings[field.key] ?? field.defaultValue ?? 0)"
                        :min="field.minimum"
                        :max="
                            field.maxFrom
                                ? Number(localSettings[field.maxFrom] ?? field.maximum)
                                : field.maximum
                        "
                        :step="field.step"
                        :editable="true"
                        :unit="field.unit ?? '%'"
                        @update:model-value="updateSetting(field.key, $event)"
                    />
                    <!-- Plain number input -->
                    <MrInput
                        v-else-if="field.type === 'number'"
                        type="number"
                        :model-value="localSettings[field.key] as number"
                        :min="field.minimum"
                        :max="getFieldMax(field)"
                        @update:model-value="updateSetting(field.key, $event)"
                    />
                    <!-- Text input (default) -->
                    <MrInput
                        v-else
                        type="text"
                        :model-value="localSettings[field.key] as string"
                        @update:model-value="updateSetting(field.key, $event)"
                    />
                </template>
            </div>
        </div>

        <div class="px-4 pt-3 pb-16 md:pb-3 flex items-center gap-2 border-t border-border">
            <MrButton size="sm" @click="applyAll">Apply All</MrButton>
            <MrButton variant="secondary" size="sm" @click="$emit('close')">Close</MrButton>
            <span v-if="saved" class="text-xs ml-auto flex items-center gap-1 text-ok">
                <svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
                    <path
                        fill-rule="evenodd"
                        d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                        clip-rule="evenodd"
                    />
                </svg>
                Saved
            </span>
        </div>
    </div>
</template>
