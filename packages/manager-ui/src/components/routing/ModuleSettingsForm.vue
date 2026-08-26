<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue';
import MrInput from '@/components/common/MrInput.vue';
import MrSelect from '@/components/common/MrSelect.vue';
import MrMultiSelect from '@/components/common/MrMultiSelect.vue';
import MrSlider from '@/components/common/MrSlider.vue';
import MrToggle from '@/components/common/MrToggle.vue';
import MrArrayField from '@/components/common/MrArrayField.vue';
import GraphField from '@/components/routing/widgets/GraphField.vue';
import type { FormField } from '@/composables/useModuleSettingsForm';
import { useSocketStore } from '@/stores/socket';
import { useEngineStore } from '@/stores/engines';

const socket = useSocketStore();
const engineStore = useEngineStore();

interface DeviceOption {
    value: string;
    label: string;
}

const props = defineProps<{
    fields: FormField[];
    settings: Record<string, unknown>;
    /** Visibility predicate from `useModuleSettingsForm`. */
    isVisible: (field: FormField) => boolean;
    /** Effective enum resolver (handles x-enumBy). */
    getEnum: (field: FormField) => unknown[] | undefined;
    /** Effective max resolver (handles x-maxBy). */
    getMax: (field: FormField) => number | undefined;
    /** Device-list resolver — closure captures the deviceStore + engineId. */
    deviceOptions: (fieldKey: string, deviceType: string) => DeviceOption[];
    /** Engine + module ids — needed by upload-style widgets that scope by plugin/module. */
    engineId: string;
    moduleId: string;
}>();

const emit = defineEmits<{ update: [key: string, value: unknown] }>();

function onUpdate(key: string, value: unknown): void {
    emit('update', key, value);
}

/**
 * Plugin id for the current module. Needed so the upload widget can scope
 * the generic `plugin:upload` RPC by plugin (each plugin gets its own
 * storage subdir on the manager host).
 */
function modulePluginId(): string {
    return engineStore.getEngine(props.engineId)?.modules[props.moduleId]?.pluginId ?? '';
}

/**
 * Options for an `x-optionsFrom` multi-select — read from the module's pushed
 * `fieldOptions` (e.g. audio / subtitle languages a plugin detected from a
 * stream). Empty until the engine has probed the source.
 */
function optionsFromState(key: string): Array<{ value: string; label: string }> {
    return engineStore.getEngine(props.engineId)?.modules[props.moduleId]?.fieldOptions?.[key] ?? [];
}

/**
 * Cached preview URLs keyed by the stored file path. We use
 * `URL.createObjectURL(Blob)` rather than base64 `data:` URLs so the bytes
 * stay as a single Blob and we don't pay for a 1.33× base64 copy + a 10-MB
 * binary string built char-by-char on the main thread. The returned URL
 * is opaque (`blob:…`) and accepted directly by `<img src>`.
 *
 * Lifecycle: every URL we put in the cache is registered for revocation
 * on unmount (and individually revoked if a path's bytes change between
 * uploads). Without `URL.revokeObjectURL` the Blob stays pinned in memory
 * for the lifetime of the document.
 */
const uploadPreviewCache = ref<Record<string, string>>({});

function setPreviewUrl(absolutePath: string, url: string): void {
    const prior = uploadPreviewCache.value[absolutePath];
    if (prior && prior !== url) URL.revokeObjectURL(prior);
    uploadPreviewCache.value = { ...uploadPreviewCache.value, [absolutePath]: url };
}

function uploadPreviewUrl(absolutePath: unknown): string {
    if (typeof absolutePath !== 'string' || !absolutePath) return '';
    return uploadPreviewCache.value[absolutePath] ?? '';
}

/**
 * `accept=` value for the file picker, derived from the plugin's manifest
 * policy. The HTML spec calls for case-insensitive extension matching, but
 * Safari (and some Chromium builds) don't honour that for casing variants
 * like `.JPG` / `.HEIC` — so we also emit the `image/*` MIME wildcard. The
 * server still enforces the strict lowercased-extension allowlist before
 * accepting the bytes.
 */
/**
 * Extensions that warrant adding the `image/*` MIME wildcard to `accept=`.
 * Kept tight to what plugin manifests actually declare today — Safari and
 * a few Chromium builds don't case-insensitive-match `.PNG` against
 * `.png`, and the MIME wildcard sidesteps that. The server still enforces
 * the strict lowercased-extension allowlist before accepting the bytes.
 */
const IMAGE_FILE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);

/**
 * `accept=` value for the file picker. Reactive on the module/plugin so
 * it recomputes only when the upload policy actually changes, not on
 * every unrelated render.
 */
const uploadAccept = computed(() => {
    const policy = engineStore.getEngine(props.engineId)?.modules[props.moduleId]?.uploads;
    if (!policy?.extensions?.length) return '';
    const lower = policy.extensions.map((e) => e.toLowerCase());
    const tokens = new Set<string>(lower);
    if (lower.some((e) => IMAGE_FILE_EXTS.has(e))) tokens.add('image/*');
    return [...tokens].join(',');
});

onBeforeUnmount(() => {
    for (const url of Object.values(uploadPreviewCache.value)) URL.revokeObjectURL(url);
});

async function loadPreview(absolutePath: string): Promise<void> {
    if (!absolutePath || uploadPreviewCache.value[absolutePath]) return;
    const idx = absolutePath.lastIndexOf('/');
    if (idx < 0) return;
    const filename = absolutePath.slice(idx + 1);
    const pluginId = modulePluginId();
    if (!pluginId) return;
    try {
        const res = await socket.request<{ bytes: ArrayBuffer | Uint8Array; contentType: string }>(
            'plugin:upload-get',
            { pluginId, filename },
        );
        if (!res?.bytes) return;
        // Server returns Node Buffer; in the browser socket.io delivers it
        // as ArrayBuffer. Both wrap into a Blob without copying the bytes.
        // (Cast through `unknown` because the TS lib's `BlobPart` excludes
        // `Uint8Array<SharedArrayBufferLike>` even though both fit at runtime.)
        const blob = new Blob([res.bytes as unknown as BlobPart], { type: res.contentType });
        setPreviewUrl(absolutePath, URL.createObjectURL(blob));
    } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[plugin upload-get] failed', err);
    }
}

/**
 * Watcher source. Collapsing the relevant settings into a single string
 * key (rather than returning a fresh array every tick) means Vue's
 * `Object.is` compare actually short-circuits on no-op changes — the
 * previous version re-fired on every reactive ripple even though
 * `loadPreview` deduped via the cache.
 */
watch(
    () =>
        props.fields
            .filter((f) => f.widget === 'imageUpload')
            .map((f) => String(props.settings[f.key] ?? ''))
            .join('\0'),
    () => {
        for (const f of props.fields) {
            if (f.widget !== 'imageUpload') continue;
            const v = props.settings[f.key];
            if (typeof v === 'string' && v) loadPreview(v);
        }
    },
    { immediate: true },
);

async function onUploadImage(field: FormField, event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const pluginId = modulePluginId();
    if (!pluginId) {
        // eslint-disable-next-line no-console
        console.error('[plugin upload] no pluginId for module', props.moduleId);
        input.value = '';
        return;
    }
    try {
        // Socket.IO encodes Uint8Array as a binary frame on the wire — no
        // base64 round-trip, same channel as the rest of the app's RPC.
        const bytes = new Uint8Array(await file.arrayBuffer());
        // Generous timeout for uploads — even a multi-megabyte image over
        // a slow link can push past the default 10 s RPC cap, and a
        // timeout here would leave the UI showing "disconnected" while
        // the server is still happily receiving bytes.
        const result = await socket.request<{ path: string; filename: string }>(
            'plugin:upload',
            { pluginId, moduleId: props.moduleId, filename: file.name, bytes },
            { timeoutMs: 5 * 60 * 1000 },
        );
        if (result?.path) {
            // Prime the preview from the bytes already in memory — same
            // Blob trick as `loadPreview`, no second RPC and no base64 copy.
            const blob = new Blob([bytes as unknown as BlobPart], {
                type: file.type || 'application/octet-stream',
            });
            setPreviewUrl(result.path, URL.createObjectURL(blob));
            emit('update', field.key, result.path);
        }
    } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[plugin upload] failed', err);
    } finally {
        // Reset so the same file can be re-selected if needed.
        input.value = '';
    }
}

function clearUpload(field: FormField): void {
    emit('update', field.key, '');
}
</script>

<template>
    <div v-if="fields.length === 0" class="text-sm py-4 text-center text-muted">
        No configurable settings.
    </div>
    <div
        v-for="field in fields"
        :key="field.key"
        v-show="isVisible(field)"
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
        <!-- Display-only widget: holds no value, renders data the plugin
             publishes. `useModuleSettingsForm` keeps it out of saved settings. -->
        <GraphField
            v-if="field.widget === 'graph'"
            :field="field"
            :engine-id="engineId"
            :module-id="moduleId"
        />
        <!-- Read-only field (auto-detected values) -->
        <div
            v-else-if="field.readOnly"
            class="w-full px-2 py-1.5 text-sm rounded-md opacity-60 bg-surface-alt border border-border-alt text-muted"
        >
            {{ settings[field.key] ?? '—' }}
        </div>
        <template v-else>
            <!-- Device picker (for x-deviceType fields) -->
            <MrSelect
                v-if="field.deviceType"
                :model-value="(settings[field.key] as string) ?? ''"
                :options="deviceOptions(field.key, field.deviceType)"
                @update:model-value="onUpdate(field.key, $event)"
            />
            <!-- Enum select (supports field-dependent options via x-enumBy) -->
            <MrSelect
                v-else-if="getEnum(field)"
                :model-value="settings[field.key] as string | number"
                :options="
                    getEnum(field)!.map((opt) => ({
                        value: (field.type === 'number' ? Number(opt) : String(opt)) as
                            | string
                            | number,
                        label: field.enumLabels?.[String(opt)] ?? String(opt),
                    }))
                "
                @update:model-value="onUpdate(field.key, $event)"
            />
            <!-- Discovery-driven multi-select (for x-optionsFrom fields, e.g. detected languages) -->
            <!-- `.filter(...)` is self-healing: a stored array from an older
                 schema rev can hold objects (e.g. `[{}, {}]` left over when
                 this field rendered as a generic MrArrayField). Stripping them
                 here means the next toggle persists a clean primitive-only
                 array, so the "[object Object]" placeholder never sticks. -->
            <MrMultiSelect
                v-else-if="field.optionsFrom"
                :model-value="
                    ((settings[field.key] as unknown[]) ?? []).filter(
                        (v): v is string | number =>
                            typeof v === 'string' || typeof v === 'number',
                    )
                "
                :options="optionsFromState(field.optionsFrom)"
                :disabled="field.readOnly"
                @update:model-value="onUpdate(field.key, $event)"
            />
            <!-- Array field -->
            <MrArrayField
                v-else-if="field.type === 'array' && field.items"
                :model-value="(settings[field.key] as unknown[]) ?? field.defaultValue ?? []"
                :schema="field.items"
                :global-config="settings"
                :global-keys="fields.map((f) => f.key)"
                :disabled="field.readOnly"
                @update:model-value="onUpdate(field.key, $event)"
            />
            <!-- Boolean toggle -->
            <MrToggle
                v-else-if="field.type === 'boolean'"
                :model-value="!!settings[field.key]"
                @update:model-value="onUpdate(field.key, $event)"
            />
            <!-- Slider for volume/gain controls -->
            <MrSlider
                v-else-if="field.widget === 'slider'"
                :model-value="Number(settings[field.key] ?? field.defaultValue ?? 0)"
                :min="field.minimum"
                :max="
                    field.maxFrom
                        ? Number(settings[field.maxFrom] ?? field.maximum)
                        : field.maximum
                "
                :step="field.step"
                :editable="true"
                :unit="field.unit ?? '%'"
                @update:model-value="onUpdate(field.key, $event)"
            />
            <!-- Image upload widget (file picker + preview + clear) -->
            <div
                v-else-if="field.widget === 'imageUpload'"
                class="space-y-2"
            >
                <div
                    v-if="settings[field.key]"
                    class="relative rounded-md border border-border-alt bg-surface-alt overflow-hidden"
                >
                    <!-- Render the img only after `loadPreview()` populates
                         the cache. Earlier we rendered with an empty src
                         and a hide-on-error handler — the empty src fired
                         the error before the async fetch resolved, leaving
                         the img permanently invisible. -->
                    <img
                        v-if="uploadPreviewUrl(settings[field.key])"
                        :src="uploadPreviewUrl(settings[field.key])"
                        :alt="String(settings[field.key])"
                        class="block w-full max-h-40 object-contain"
                    />
                    <div
                        v-else
                        class="flex items-center justify-center h-20 text-[10px] text-muted"
                    >
                        Loading preview…
                    </div>
                    <div class="px-2 py-1 flex items-center justify-between border-t border-border-alt">
                        <span class="text-[10px] truncate text-muted" :title="String(settings[field.key])">
                            {{ String(settings[field.key]).split('/').pop() }}
                        </span>
                        <button
                            type="button"
                            class="text-[10px] text-error hover:underline"
                            @click="clearUpload(field)"
                        >
                            Remove
                        </button>
                    </div>
                </div>
                <label
                    class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md cursor-pointer border border-border bg-surface-alt hover:opacity-80 text-foreground"
                >
                    <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                    >
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="17 8 12 3 7 8" />
                        <line x1="12" y1="3" x2="12" y2="15" />
                    </svg>
                    {{ settings[field.key] ? 'Replace image' : 'Upload image' }}
                    <input
                        type="file"
                        :accept="uploadAccept"
                        class="hidden"
                        @change="onUploadImage(field, $event)"
                    />
                </label>
            </div>
            <!-- Plain number input -->
            <MrInput
                v-else-if="field.type === 'number'"
                type="number"
                :model-value="settings[field.key] as number"
                :min="field.minimum"
                :max="getMax(field)"
                @update:model-value="onUpdate(field.key, $event)"
            />
            <!-- Text input (default) -->
            <MrInput
                v-else
                type="text"
                :model-value="settings[field.key] as string"
                @update:model-value="onUpdate(field.key, $event)"
            />
        </template>
    </div>
</template>
