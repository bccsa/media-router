<script setup lang="ts">
import { ref } from 'vue';
// shared-types is CJS: named imports break under Vite's interop (see stores/engines.ts).
import * as shared from '@media-router/shared-types';
import MrModal from '@/components/common/MrModal.vue';
import MrInput from '@/components/common/MrInput.vue';
import MrSelect from '@/components/common/MrSelect.vue';
import MrToggle from '@/components/common/MrToggle.vue';
import MrButton from '@/components/common/MrButton.vue';

import type { Settings } from './useDraft';

const { DASHBOARD_MAX_CELLS } = shared;

const props = defineProps<{ settings: Settings }>();
const emit = defineEmits<{ apply: [patch: Settings]; close: [] }>();

const form = ref<Settings>({ ...props.settings });
const THEMES = [
    { value: 'dark', label: 'Dark' },
    { value: 'light', label: 'Light' },
];
const cells = (v: unknown) => Math.min(DASHBOARD_MAX_CELLS, Math.max(1, Math.round(Number(v) || 1)));

function apply() {
    emit('apply', { ...form.value, name: form.value.name.trim(), cols: cells(form.value.cols), rows: cells(form.value.rows) });
}
</script>

<template>
    <MrModal title="Dashboard settings" @close="emit('close')">
        <div class="space-y-3">
            <MrInput v-model="form.name" label="Name" description="Shown in menus and used in the router address /d/<name>" />
            <div class="grid grid-cols-2 gap-3">
                <MrInput v-model.number="form.cols" label="Columns" type="number" :min="1" :max="DASHBOARD_MAX_CELLS" />
                <MrInput v-model.number="form.rows" label="Rows" type="number" :min="1" :max="DASHBOARD_MAX_CELLS" />
            </div>
            <MrToggle v-model="form.scroll" label="Scroll" description="Off: the grid always fits the screen. On: fixed cells, the page scrolls." />
            <MrToggle v-model="form.zoom" label="Pinch zoom" description="Pinch or Ctrl+wheel to zoom, drag the background to pan" />
            <MrToggle v-model="form.locked" label="Locked" description="No dashboard menu on screen (a browser's address bar and Back still work)" />
            <MrSelect v-model="form.theme" label="Theme" :options="THEMES" />
        </div>
        <template #footer>
            <MrButton variant="secondary" @click="emit('close')">Cancel</MrButton>
            <MrButton :disabled="!form.name.trim()" @click="apply">Apply</MrButton>
        </template>
    </MrModal>
</template>
