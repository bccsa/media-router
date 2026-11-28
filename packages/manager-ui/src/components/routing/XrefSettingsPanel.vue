<script setup lang="ts">
/**
 * Side panel of one cross-reference tag (ADR-0030): its name, and what it is
 * bound to and linked with. Same shell as ModuleSettingsPanel; props in,
 * emits out.
 */
import { computed, onMounted, onUnmounted } from 'vue';
// shared-types is CJS: a namespace import is the safe interop (see stores/engines.ts).
import * as shared from '@media-router/shared-types';
import MrButton from '@/components/common/MrButton.vue';
import MrInput from '@/components/common/MrInput.vue';
import { counterpartLabel, counterpartOf, portLabelKey } from '@/utils/xrefMenuItems';
import type { EntryRule } from '@/utils/entryRules';
import type {
    RefLink,
    RefNode,
    XrefSettingsPanelEmits,
    XrefSettingsPanelProps,
} from '../../utils/crossRefTypes';

const { REF_NAME_MAX } = shared;

const props = defineProps<
    XrefSettingsPanelProps & {
        /** `portLabelKey(moduleId, portId)` → port label; the port id when missing. */
        portLabels?: Record<string, string>;
        /** Every tag, so a linked row shows the far tag's label. */
        refs?: Record<string, RefNode>;
    }
>();
const emit = defineEmits<XrefSettingsPanelEmits>();

function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') emit('close');
}
onMounted(() => document.addEventListener('keydown', onKeydown));
onUnmounted(() => document.removeEventListener('keydown', onKeydown));

const tag = computed(() => props.refNode);
const kindLabel = computed(() =>
    tag.value.kind === 'out' ? 'Output reference' : 'Input reference',
);
const number = computed(() => {
    if (tag.value.n !== undefined) return `#${tag.value.n}`;
    return tag.value.readOnly ? 'None' : 'Assigning…';
});
const boundPort = computed(() => {
    const { moduleId, portId } = tag.value;
    const port = props.portLabels?.[portLabelKey(moduleId, portId)] ?? portId;
    return `${props.moduleNames[moduleId] ?? moduleId}/${port}`;
});

// Committed on Enter or leaving the box (MrInput with a rule).
const nameRule: EntryRule = { type: 'string', maxLength: REF_NAME_MAX };
function onName(value: string | number) {
    const name = String(value).trim();
    if (name === (tag.value.name ?? '')) return;
    emit('rename', tag.value.key, name || null);
}

const canUnlink = (link: RefLink) => !link.readOnly && !tag.value.readOnly;
const linkLabel = (link: RefLink) => counterpartLabel(tag.value, link, props);
</script>

<template>
    <div
        class="fixed right-0 top-12 h-[calc(100vh-3rem)] w-80 z-30 flex flex-col shadow-xl bg-card border-l border-border"
    >
        <div class="flex items-start justify-between px-4 py-3 border-b border-border">
            <div class="flex-1 min-w-0 mr-2">
                <div class="flex items-center gap-2">
                    <span class="w-3 h-3 rounded-sm shrink-0" :style="{ background: tag.color }" />
                    <h3 class="text-sm font-semibold text-foreground break-words min-w-0">
                        {{ tag.label }}
                    </h3>
                </div>
                <div class="text-[11px] mt-0.5 text-muted">{{ kindLabel }}</div>
            </div>
            <button
                data-test="close"
                aria-label="Close"
                class="p-1 rounded-md text-muted"
                @click="emit('close')"
            >
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

        <div class="flex-1 overflow-y-auto px-4 py-3 space-y-4">
            <MrInput
                :key="tag.key"
                label="Name"
                :description="
                    tag.readOnly
                        ? 'A PipeWire wire across pages has no name or number: move these modules together.'
                        : 'Shown on the tag instead of its number. Clear it to show the number again.'
                "
                :model-value="tag.name ?? ''"
                :placeholder="tag.n !== undefined ? `#${tag.n}` : ''"
                :rule="nameRule"
                :disabled="tag.readOnly"
                @update:model-value="onName"
            />

            <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
                <dt class="text-muted">Type</dt>
                <dd class="text-foreground">{{ kindLabel }}</dd>
                <dt class="text-muted">Number</dt>
                <dd data-test="number" class="text-foreground">{{ number }}</dd>
                <dt class="text-muted">{{ tag.kind === 'out' ? 'From' : 'To' }}</dt>
                <dd>
                    <button
                        data-test="module"
                        class="text-left text-accent hover:underline break-words"
                        @click="emit('selectModule', tag.moduleId)"
                    >
                        {{ boundPort }}
                    </button>
                </dd>
                <dt class="text-muted">Page</dt>
                <dd class="text-foreground break-words">{{ pageNames[tag.page] ?? '' }}</dd>
                <dt class="text-muted">Stream</dt>
                <dd class="text-foreground">{{ tag.streamType ?? 'Unknown' }}</dd>
            </dl>

            <section>
                <h4 class="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
                    Linked references
                </h4>
                <p v-if="tag.links.length === 0" class="text-xs text-muted">No links</p>
                <ul class="space-y-1">
                    <li
                        v-for="link in tag.links"
                        :key="link.connectionId"
                        data-test="link"
                        class="flex items-start gap-2"
                    >
                        <button
                            data-test="goto"
                            class="flex-1 min-w-0 text-left text-xs text-accent hover:underline break-words"
                            @click="emit('goto', counterpartOf(tag, link).key)"
                        >
                            {{ linkLabel(link) }}
                        </button>
                        <MrButton
                            v-if="canUnlink(link)"
                            data-test="unlink"
                            size="sm"
                            variant="danger"
                            class="shrink-0"
                            @click="emit('unlink', link.connectionId)"
                        >
                            Unlink…
                        </MrButton>
                    </li>
                </ul>
            </section>
        </div>
    </div>
</template>
