<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import MrButton from '@/components/common/MrButton.vue';
import MrInput from '@/components/common/MrInput.vue';
import MrSelect from '@/components/common/MrSelect.vue';
import MrSlider from '@/components/common/MrSlider.vue';
import MrToggle from '@/components/common/MrToggle.vue';
import { useEngineStore } from '@/stores/engines';
import { useSocketStore } from '@/stores/socket';

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

const module = computed(() => engineStore.getEngine(props.engineId)?.modules[props.moduleId]);

// Rename
const editName = ref('');
watch(() => module.value?.displayName, (name) => {
    if (name && !editName.value) editName.value = name;
}, { immediate: true });

function saveName() {
    const trimmed = editName.value.trim();
    if (trimmed && trimmed !== module.value?.displayName) {
        socket.emit('module:rename', { engineId: props.engineId, moduleId: props.moduleId, displayName: trimmed });
    }
}

interface FormField {
    key: string; type: string; label: string; description: string;
    defaultValue: unknown; enumValues?: unknown[]; liveUpdatable: boolean;
    deviceType?: string; // 'source' or 'sink' — shows device picker
    widget?: string; // 'slider' etc.
    minimum?: number; maximum?: number; step?: number;
    maxFrom?: string; // key of another setting that controls slider max
    enumByCodec?: Record<string, unknown[]>; // codec → valid enum values
    readOnly?: boolean; // x-readOnly — show value but greyed out
}

// Fetch audio devices for device picker fields
const audioDevices = ref<Array<{ name: string; description: string; direction: string; channels: number; sampleRate: number }>>([]);
onMounted(async () => {
    try {
        const res = await fetch('/api/v1/audio/devices');
        if (res.ok) audioDevices.value = await res.json();
    } catch (err) {
        console.warn('[ModuleSettings] Failed to load audio devices:', err);
    }
});

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
    'x-enumByCodec'?: Record<string, unknown[]>;
    'x-readOnly'?: boolean;
}

const formFields = computed<FormField[]>(() => {
    const schema = module.value?.configSchema;
    if (!schema?.properties) return [];
    const schemaProps = schema.properties as Record<string, SchemaProperty>;
    return Object.entries(schemaProps).map(([key, prop]) => ({
        key,
        type: prop.type ?? 'string',
        label: key.replace(/([A-Z])/g, ' $1').replace(/^./, (s: string) => s.toUpperCase()),
        description: prop.description ?? '',
        defaultValue: prop.default,
        enumValues: prop.enum,
        liveUpdatable: !!prop['x-live'] || !!prop['x-liveUpdatable'],
        deviceType: prop['x-deviceType'],
        widget: prop['x-widget'],
        minimum: prop.minimum,
        maximum: prop.maximum,
        step: prop['x-step'],
        maxFrom: prop['x-maxFrom'],
        enumByCodec: prop['x-enumByCodec'],
        readOnly: !!prop['x-readOnly'],
    }));
});

/** Resolve effective enum values for a field — checks enumByCodec first. */
function getFieldEnum(field: FormField): unknown[] | undefined {
    if (field.enumByCodec) {
        const codec = (localSettings.value.codec as string) ?? 'opus';
        return field.enumByCodec[codec] ?? field.enumValues;
    }
    return field.enumValues;
}

const localSettings = ref<Record<string, unknown>>({});

watch(module, (m) => {
    if (m) {
        const defaults: Record<string, unknown> = {};
        for (const f of formFields.value) {
            if (f.defaultValue !== undefined) defaults[f.key] = f.defaultValue;
        }
        localSettings.value = { ...defaults, ...m.settings };
    }
}, { immediate: true });

// Throttle live updates (sliders) to max once per 50ms, with a final send on release
let liveThrottleTimer: ReturnType<typeof setTimeout> | null = null;
let pendingLiveUpdate: { key: string; value: unknown } | null = null;

onUnmounted(() => {
    if (liveThrottleTimer) { clearTimeout(liveThrottleTimer); liveThrottleTimer = null; }
    if (pendingLiveUpdate) {
        sendLiveUpdate(pendingLiveUpdate.key, pendingLiveUpdate.value);
        pendingLiveUpdate = null;
    }
});

function sendLiveUpdate(key: string, value: unknown) {
    socket.emit('module:config', { engineId: props.engineId, moduleId: props.moduleId, changes: { [key]: value } });
}

function updateSetting(key: string, value: unknown) {
    localSettings.value = { ...localSettings.value, [key]: value };
    const field = formFields.value.find((f) => f.key === key);
    if (field?.liveUpdatable) {
        pendingLiveUpdate = { key, value };
        if (!liveThrottleTimer) {
            sendLiveUpdate(key, value);
            liveThrottleTimer = setTimeout(() => {
                liveThrottleTimer = null;
                // Send final value if changed during throttle window
                if (pendingLiveUpdate) {
                    sendLiveUpdate(pendingLiveUpdate.key, pendingLiveUpdate.value);
                    pendingLiveUpdate = null;
                }
            }, 50);
        }
    }
}

const isEnabled = computed(() => module.value?.enabled !== false);

function doRestart() {
    socket.emit('module:restart', { engineId: props.engineId, moduleId: props.moduleId });
}
function doToggle() {
    socket.emit('module:toggle', { engineId: props.engineId, moduleId: props.moduleId, enabled: !isEnabled.value });
}
function doClone() {
    const mod = module.value;
    if (mod) {
        socket.emit('module:add', {
            engineId: props.engineId,
            pluginId: mod.pluginId,
            displayName: mod.displayName + ' (copy)',
            position: { x: (mod.position?.x ?? 100) + 50, y: (mod.position?.y ?? 100) + 50 },
            settings: { ...mod.settings },
        });
    }
}
function doDelete() {
    if (confirm(`Delete "${module.value?.displayName}"?`)) {
        socket.emit('module:delete', { engineId: props.engineId, moduleId: props.moduleId });
        emit('close');
    }
}

const saved = ref(false);

function applyAll() {
    socket.emit('module:config', { engineId: props.engineId, moduleId: props.moduleId, changes: localSettings.value });
    saved.value = true;
    setTimeout(() => { saved.value = false; }, 2000);
}
</script>

<template>
    <div class="fixed right-0 top-0 h-screen w-80 z-30 flex flex-col shadow-xl"
         :style="{ backgroundColor: 'var(--bg-card)', borderLeft: '1px solid var(--border-primary)' }">
        <div class="flex items-center justify-between px-4 py-3" :style="{ borderBottom: '1px solid var(--border-primary)' }">
            <input v-model="editName" class="text-sm font-semibold bg-transparent border-b outline-none flex-1 mr-2"
                   :style="{ color: 'var(--text-primary)', borderColor: 'var(--border-primary)' }"
                   @keydown.enter="($event.target as HTMLInputElement).blur()" @blur="saveName" />
            <button @click="$emit('close')" class="p-1 rounded-md" :style="{ color: 'var(--text-muted)' }">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
        </div>

        <!-- Quick actions -->
        <div class="flex items-center justify-around px-3 py-2" :style="{ borderBottom: '1px solid var(--border-primary)' }">
            <button @click="doRestart" class="flex flex-col items-center gap-0.5 px-2 py-1 rounded-md transition-colors hover:opacity-80"
                    :style="{ color: 'var(--text-secondary)' }">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                </svg>
                <span class="text-[9px]">Restart</span>
            </button>
            <button @click="doToggle" class="flex flex-col items-center gap-0.5 px-2 py-1 rounded-md transition-colors hover:opacity-80"
                    :style="{ color: isEnabled ? 'var(--text-secondary)' : 'var(--health-ok)' }">
                <svg v-if="isEnabled" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M18.36 6.64A9 9 0 0 1 20.77 15M2 12a10 10 0 0 0 18.77 3" /><line x1="1" y1="1" x2="23" y2="23" />
                </svg>
                <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                <span class="text-[9px]">{{ isEnabled ? 'Disable' : 'Enable' }}</span>
            </button>
            <button @click="doClone" class="flex flex-col items-center gap-0.5 px-2 py-1 rounded-md transition-colors hover:opacity-80"
                    :style="{ color: 'var(--text-secondary)' }">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
                <span class="text-[9px]">Clone</span>
            </button>
            <button @click="doDelete" class="flex flex-col items-center gap-0.5 px-2 py-1 rounded-md transition-colors hover:opacity-80"
                    :style="{ color: 'var(--health-error)' }">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                </svg>
                <span class="text-[9px]">Delete</span>
            </button>
        </div>

        <div class="flex-1 overflow-y-auto p-4 space-y-4">
            <div v-if="formFields.length === 0" class="text-sm py-4 text-center" :style="{ color: 'var(--text-muted)' }">No configurable settings.</div>
            <div v-for="field in formFields" :key="field.key" class="space-y-1.5">
                <label class="flex items-center gap-1 text-xs font-medium" :style="{ color: 'var(--text-secondary)' }">
                    {{ field.label }}
                    <span v-if="field.liveUpdatable" class="text-amber-500 text-[10px] cursor-help relative group">&#9889;
                        <span class="hidden group-hover:block absolute left-4 -top-1 w-40 p-2 rounded-md shadow-lg text-[9px] leading-relaxed" style="z-index:9999"
                              :style="{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-primary)', color: 'var(--text-primary)' }">
                            Live update — changes apply instantly without restarting the module
                        </span>
                    </span>
                </label>
                <p v-if="field.description" class="text-[10px]" :style="{ color: 'var(--text-muted)' }">{{ field.description }}</p>
                <!-- Read-only field (auto-detected values) -->
                <div v-if="field.readOnly" class="w-full px-2 py-1.5 text-sm rounded-md opacity-60"
                     :style="{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-secondary)', color: 'var(--text-muted)' }">
                    {{ localSettings[field.key] ?? '—' }}
                </div>
                <!-- Device picker (for x-deviceType fields) -->
                <template v-else>
                <MrSelect v-if="field.deviceType"
                          :model-value="localSettings[field.key] as string ?? ''"
                          :options="[
                              { value: '', label: 'Default device' },
                              ...audioDevices.filter(d => d.direction === field.deviceType).map(d => ({
                                  value: d.name,
                                  label: `${d.description || d.name} (${d.channels}ch, ${d.sampleRate}Hz)`,
                              })),
                          ]"
                          @update:model-value="updateSetting(field.key, $event)" />
                <!-- Enum select (supports codec-dependent options via x-enumByCodec) -->
                <MrSelect v-else-if="getFieldEnum(field)"
                          :model-value="localSettings[field.key] as string | number"
                          :options="getFieldEnum(field)!.map(opt => ({ value: (field.type === 'number' ? Number(opt) : String(opt)) as string | number, label: String(opt) }))"
                          @update:model-value="updateSetting(field.key, $event)" />
                <!-- Boolean toggle -->
                <MrToggle v-else-if="field.type === 'boolean'"
                          :model-value="!!localSettings[field.key]"
                          @update:model-value="updateSetting(field.key, $event)" />
                <!-- Slider for volume/gain controls -->
                <div v-else-if="field.widget === 'slider'" class="flex items-center gap-2">
                    <MrSlider class="flex-1"
                              :model-value="Number(localSettings[field.key] ?? field.defaultValue ?? 1)"
                              :min="field.minimum ?? 0"
                              :max="field.maxFrom ? Number(localSettings[field.maxFrom] ?? field.maximum ?? 2) : (field.maximum ?? 2)"
                              :step="field.step ?? 0.01"
                              @update:model-value="updateSetting(field.key, $event)" />
                    <span class="text-xs w-12 text-right tabular-nums" :style="{ color: 'var(--text-secondary)' }">
                        {{ Math.round(Number(localSettings[field.key] ?? field.defaultValue ?? 100)) }}%
                    </span>
                </div>
                <!-- Plain number input -->
                <MrInput v-else-if="field.type === 'number'" type="number"
                         :model-value="localSettings[field.key] as number"
                         @update:model-value="updateSetting(field.key, $event)" />
                <!-- Text input (default) -->
                <MrInput v-else type="text"
                         :model-value="localSettings[field.key] as string"
                         @update:model-value="updateSetting(field.key, $event)" />
                </template>
            </div>
        </div>

        <div class="px-4 pt-3 pb-16 md:pb-3 flex items-center gap-2" :style="{ borderTop: '1px solid var(--border-primary)' }">
            <MrButton size="sm" @click="applyAll">Apply All</MrButton>
            <MrButton variant="secondary" size="sm" @click="$emit('close')">Close</MrButton>
            <span v-if="saved" class="text-xs ml-auto flex items-center gap-1" :style="{ color: 'var(--health-ok)' }">
                <svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" /></svg>
                Saved
            </span>
        </div>
    </div>
</template>
