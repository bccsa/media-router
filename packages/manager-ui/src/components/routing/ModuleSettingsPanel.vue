<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, toRef } from 'vue';
import MrButton from '@/components/common/MrButton.vue';
import ModuleSettingsForm from './ModuleSettingsForm.vue';
import { useEngineStore } from '@/stores/engines';
import { useSocketStore } from '@/stores/socket';
import { useDeviceStore } from '@/stores/devices';
import { patch } from '@/composables/usePatch';
import { useModuleSettingsForm } from '@/composables/useModuleSettingsForm';

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

// Form state machinery (schema → fields, throttled live updates) lives in
// the composable so this file stays focused on layout + lifecycle.
const { formFields, localSettings, isFieldVisible, getFieldEnum, getFieldMax, updateSetting, applyAll } =
    useModuleSettingsForm({
        engineId: toRef(props, 'engineId'),
        moduleId: toRef(props, 'moduleId'),
        module,
    });

// Device lists come from `useDeviceStore`, populated live via socket push.
// This panel does one HTTP snapshot per required type on open so dropdowns
// render without waiting for the first push.
const requiredDeviceTypes = computed<string[]>(() => {
    const schema = module.value?.configSchema as { properties?: Record<string, { 'x-deviceType'?: string }> } | undefined;
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
        const devices = await socket.request<unknown[]>('device:list', {
            engineId: props.engineId,
            type,
        });
        deviceStore.set(props.engineId, type, devices as never);
    } catch (err) {
        console.warn('[ModuleSettings] Failed to load device list', type, err);
        fetchedKeys.delete(cacheKey); // retry on next change
    }
}

// Re-run whenever the set of required types changes — covers both initial
// mount (configSchema arrives async over the wire) and module switching.
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

function onApplyAll() {
    applyAll();
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
            <ModuleSettingsForm
                :fields="formFields"
                :settings="localSettings"
                :is-visible="isFieldVisible"
                :get-enum="getFieldEnum"
                :get-max="getFieldMax"
                :device-options="deviceOptions"
                @update="updateSetting"
            />
        </div>

        <div class="px-4 pt-3 pb-16 md:pb-3 flex items-center gap-2 border-t border-border">
            <MrButton size="sm" @click="onApplyAll">Apply All</MrButton>
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
