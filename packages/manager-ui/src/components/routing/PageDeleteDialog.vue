<script setup lang="ts">
/** Asks which page takes a deleted page's modules (PageTabs). */
import { ref, computed } from 'vue';
import MrModal from '@/components/common/MrModal.vue';
import MrSelect from '@/components/common/MrSelect.vue';
import MrButton from '@/components/common/MrButton.vue';
import type { PageTab } from '../../utils/crossRefTypes';

const props = defineProps<{ page: PageTab; pages: PageTab[] }>();
const emit = defineEmits<{ confirm: [targetId: string]; close: [] }>();

const options = computed(() =>
    props.pages.filter((p) => p.id !== props.page.id).map((p) => ({ value: p.id, label: p.name })),
);

// The tab to its left by default, else the one to its right.
const at = props.pages.findIndex((p) => p.id === props.page.id);
const target = ref<string | number>((props.pages[at - 1] ?? props.pages[at + 1])?.id ?? '');
// Another browser may delete the chosen page meanwhile.
const valid = computed(() => options.value.some((o) => o.value === target.value));

const message = computed(() => {
    const n = props.page.moduleCount;
    if (n === 0) return 'This page has no modules.';
    return `Its ${n} module${n === 1 ? '' : 's'} move to the page you choose, right of what is there, keeping their layout.`;
});

function confirm() {
    if (valid.value) emit('confirm', String(target.value));
}
</script>

<template>
    <MrModal :title="`Delete page “${page.name}”`" @close="emit('close')">
        <p class="mb-3 text-sm text-subtle">{{ message }}</p>
        <MrSelect v-model="target" label="Move its modules to" :options="options" />
        <template #footer>
            <MrButton size="sm" variant="secondary" @click="emit('close')">Cancel</MrButton>
            <MrButton
                data-test="confirm-delete"
                size="sm"
                variant="danger"
                :disabled="!valid"
                @click="confirm"
                >Delete page</MrButton
            >
        </template>
    </MrModal>
</template>
