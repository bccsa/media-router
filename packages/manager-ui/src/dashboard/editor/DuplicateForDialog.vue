<script setup lang="ts">
import { computed, ref } from 'vue';
import MrModal from '@/components/common/MrModal.vue';
import MrInput from '@/components/common/MrInput.vue';
import MrSelect from '@/components/common/MrSelect.vue';
import { useModules } from './useModules';
import { useRouters } from '../useRouters';
import type { DashboardSource } from '../source';
import { routerOf } from '../paths';

/** Duplicate for… (ADR-0026): the module the copies are tied to. */
const props = defineProps<{ source: DashboardSource; fromModule: string; pickRouter?: boolean }>();
const emit = defineEmits<{ pick: [modulePath: string]; close: [] }>();

// `/modules/m1` on a router dashboard, `/engines/e/modules/m1` on a manager
// one, where the copies may go to a module on another router.
const router = ref(routerOf(props.fromModule) ?? '');
const base = computed(() => {
    const id = props.pickRouter && router.value ? router.value : routerOf(props.fromModule);
    return id ? `/engines/${id}` : '';
});
const { options: routers } = useRouters(props.source, () => !!props.pickRouter);
const modules = useModules(props.source, () => base.value);
const filter = ref('');
const shown = computed(() => {
    const q = filter.value.trim().toLowerCase();
    return modules.value.filter((m) => `${base.value}/modules/${m.id}` !== props.fromModule && (!q || `${m.name} ${m.pluginId}`.toLowerCase().includes(q)));
});
</script>

<template>
    <MrModal title="Duplicate for another module" @close="emit('close')">
        <p class="text-xs text-subtle mb-2">The copies go beside the selection, tied to the same values on the module you pick.</p>
        <MrSelect v-if="pickRouter" v-model="router" label="Router" :options="routers" searchable class="mb-2" />
        <MrInput v-model="filter" placeholder="Search modules" />
        <div class="space-y-1 max-h-96 overflow-auto mt-2">
            <button
                v-for="m in shown"
                :key="m.id"
                class="block w-full text-left px-2.5 py-2 rounded-md text-sm text-foreground hover:bg-accent-muted"
                @click="emit('pick', `${base}/modules/${m.id}`)"
            >
                {{ m.name }} <span class="text-muted text-xs">{{ m.pluginId }}</span>
            </button>
        </div>
    </MrModal>
</template>
