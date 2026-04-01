<script setup lang="ts">
import { ref, computed } from 'vue';
import { useEngineStore } from '@/stores/engines';
import MrButton from '@/components/common/MrButton.vue';
import MrModal from '@/components/common/MrModal.vue';

const engineStore = useEngineStore();
const search = ref('');
const filteredEngines = computed(() => {
    if (!search.value) return engineStore.engineList;
    const q = search.value.toLowerCase();
    return engineStore.engineList.filter(
        (e) => e.name.toLowerCase().includes(q) || e.engineId.toLowerCase().includes(q),
    );
});

const showRegister = ref(false);
const form = ref({ engineId: '', displayName: '', password: '' });
const loading = ref(false);
const error = ref('');

async function register() {
    if (!form.value.engineId || !form.value.displayName || !form.value.password) {
        error.value = 'All fields are required';
        return;
    }
    loading.value = true;
    error.value = '';
    try {
        const res = await fetch('/api/v1/engines', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(form.value),
        });
        if (!res.ok) {
            const data = await res.json();
            error.value = data.error ?? 'Failed';
            return;
        }
        showRegister.value = false;
        form.value = { engineId: '', displayName: '', password: '' };
    } catch { error.value = 'Network error'; }
    finally { loading.value = false; }
}
</script>

<template>
    <div class="p-6">
        <div class="flex items-center justify-between mb-5">
            <h1 class="text-xl font-semibold text-foreground">Engines</h1>
            <MrButton size="sm" @click="showRegister = true">Register Engine</MrButton>
        </div>

        <div v-if="engineStore.engineList.length > 3" class="mb-4">
            <input v-model="search" type="text" placeholder="Search engines..."
                   class="w-full max-w-xs px-3 py-1.5 text-sm rounded-md outline-none bg-input border border-border text-foreground" />
        </div>

        <div v-if="engineStore.engineList.length === 0" class="text-center py-16 text-muted">
            <p class="text-lg mb-2">No engines registered</p>
            <MrButton @click="showRegister = true">Register your first engine</MrButton>
        </div>

        <div class="grid gap-3" style="grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));">
            <RouterLink v-for="engine in filteredEngines" :key="engine.engineId"
                        :to="`/engines/${engine.engineId}`"
                        class="rounded-lg p-4 transition-colors bg-card border border-border">
                <div class="flex items-center gap-2 mb-2">
                    <div class="w-2.5 h-2.5 rounded-full"
                         :class="engine.online ? 'bg-ok' : 'bg-stopped'" />
                    <span class="font-medium text-foreground">{{ engine.name }}</span>
                </div>
                <div class="text-xs space-y-1 text-muted">
                    <div>ID: {{ engine.engineId }}</div>
                    <div v-if="engine.ips?.length">{{ engine.ips.join(', ') }}</div>
                    <div v-if="engine.buildNumber" class="opacity-70">{{ engine.buildNumber }}</div>
                    <div>Profile: {{ engine.activeProfile ?? 'None' }}</div>
                    <div>Modules: {{ Object.keys(engine.modules).length }}</div>
                </div>
            </RouterLink>
        </div>
    </div>

    <MrModal v-if="showRegister" title="Register Engine" @close="showRegister = false">
        <form @submit.prevent="register" class="space-y-3">
            <div>
                <label class="block text-xs font-medium mb-1 text-subtle">Engine ID</label>
                <input v-model="form.engineId" type="text" class="w-full px-3 py-2 text-sm rounded-md bg-input border border-border text-foreground" />
            </div>
            <div>
                <label class="block text-xs font-medium mb-1 text-subtle">Display Name</label>
                <input v-model="form.displayName" type="text" class="w-full px-3 py-2 text-sm rounded-md bg-input border border-border text-foreground" />
            </div>
            <div>
                <label class="block text-xs font-medium mb-1 text-subtle">Password</label>
                <input v-model="form.password" type="password" class="w-full px-3 py-2 text-sm rounded-md bg-input border border-border text-foreground" />
            </div>
            <div v-if="error" class="text-sm text-red-400">{{ error }}</div>
        </form>
        <template #footer>
            <MrButton variant="secondary" @click="showRegister = false">Cancel</MrButton>
            <MrButton :loading="loading" @click="register">Register</MrButton>
        </template>
    </MrModal>
</template>
