<script setup lang="ts">
import { ref, onMounted, nextTick } from 'vue';
import MrButton from '@/components/common/MrButton.vue';

const props = defineProps<{
    label: string;
}>();

const emit = defineEmits<{
    (e: 'save', label: string): void;
    (e: 'close'): void;
}>();

const localLabel = ref(props.label);
const inputRef = ref<HTMLInputElement | null>(null);

onMounted(() => {
    nextTick(() => inputRef.value?.focus());
});

function save() {
    emit('save', localLabel.value);
}
</script>

<template>
    <Teleport to="body">
        <div class="fixed inset-0 z-[999] flex items-center justify-center" @click.self="emit('close')">
            <div class="rounded-lg shadow-xl p-4 w-72"
                 :style="{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-primary)' }">
                <div class="text-sm font-medium mb-2" :style="{ color: 'var(--text-primary)' }">Edit Link Label</div>
                <input ref="inputRef" v-model="localLabel" placeholder="Enter label..."
                       class="w-full px-3 py-1.5 text-sm rounded-md mb-3"
                       :style="{ backgroundColor: 'var(--bg-input)', border: '1px solid var(--border-primary)', color: 'var(--text-primary)' }"
                       @keydown.enter="save" @keydown.esc="emit('close')" />
                <div class="flex justify-end gap-2">
                    <MrButton size="sm" variant="secondary" @click="emit('close')">Cancel</MrButton>
                    <MrButton size="sm" @click="save">Save</MrButton>
                </div>
            </div>
        </div>
    </Teleport>
</template>
