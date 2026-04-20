<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useEngineStore } from '@/stores/engines';
import { useSocketStore } from '@/stores/socket';
import MrButton from '@/components/common/MrButton.vue';
import MrModal from '@/components/common/MrModal.vue';
import MrInput from '@/components/common/MrInput.vue';

const props = defineProps<{ engineId: string }>();
const engineStore = useEngineStore();
const socket = useSocketStore();
const engine = computed(() => engineStore.getEngine(props.engineId));

const profiles = ref<Array<{ profile_name: string }>>([]);
const showCreate = ref(false);
const newProfileName = ref('');
const showSwitchConfirm = ref<string | null>(null);
const showDeleteConfirm = ref<string | null>(null);
const showImport = ref(false);
const importData = ref('');
const importName = ref('');
const error = ref('');

async function loadProfiles() {
    error.value = '';
    try {
        const res = await fetch(`/api/v1/engines/${props.engineId}/profiles`);
        if (res.ok) profiles.value = await res.json();
        else error.value = 'Failed to load profiles';
    } catch {
        error.value = 'Network error loading profiles';
    }
}

async function createProfile() {
    if (!newProfileName.value.trim()) return;
    error.value = '';
    try {
        const res = await fetch(`/api/v1/engines/${props.engineId}/profiles`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ profileName: newProfileName.value.trim() }),
        });
        if (!res.ok) {
            error.value = 'Failed to create profile';
            return;
        }
        newProfileName.value = '';
        showCreate.value = false;
        await loadProfiles();
    } catch {
        error.value = 'Network error creating profile';
    }
}

async function switchProfile(name: string) {
    error.value = '';
    try {
        const res = await fetch(`/api/v1/engines/${props.engineId}/profiles/${name}/activate`, {
            method: 'POST',
        });
        if (!res.ok) {
            error.value = 'Failed to activate profile';
            return;
        }
        showSwitchConfirm.value = null;
        if (engine.value?.running) {
            socket.emit('engine:stop', { engineId: props.engineId });
        }
        await loadProfiles();
    } catch {
        error.value = 'Network error activating profile';
    }
}

async function deleteProfile(name: string) {
    error.value = '';
    try {
        const res = await fetch(`/api/v1/engines/${props.engineId}/profiles/${name}`, {
            method: 'DELETE',
        });
        if (!res.ok) {
            error.value = 'Failed to delete profile';
            return;
        }
        showDeleteConfirm.value = null;
        await loadProfiles();
    } catch {
        error.value = 'Network error deleting profile';
    }
}

// --- Version history ---
const showHistory = ref<string | null>(null);
const history = ref<Array<{ id: number; saved_at: string; config: string }>>([]);
const previewVersion = ref<{ id: number; config: string } | null>(null);
const showRollbackConfirm = ref<number | null>(null);

async function loadHistory(profileName: string) {
    if (showHistory.value === profileName) {
        showHistory.value = null;
        return;
    }
    showHistory.value = profileName;
    try {
        const res = await fetch(
            `/api/v1/engines/${props.engineId}/profiles/${profileName}/history`,
        );
        if (res.ok) history.value = await res.json();
    } catch {
        history.value = [];
    }
}

async function rollback(versionId: number) {
    if (!showHistory.value) return;
    error.value = '';
    try {
        const res = await fetch(
            `/api/v1/engines/${props.engineId}/profiles/${showHistory.value}/rollback`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ versionId }),
            },
        );
        if (!res.ok) {
            error.value = 'Failed to rollback';
            return;
        }
        showRollbackConfirm.value = null;
        previewVersion.value = null;
        await loadHistory(showHistory.value);
    } catch {
        error.value = 'Network error during rollback';
    }
}

async function exportProfile(name: string) {
    error.value = '';
    try {
        const res = await fetch(`/api/v1/engines/${props.engineId}/profiles/${name}/config`);
        if (!res.ok) {
            error.value = 'Failed to export profile';
            return;
        }
        const config = await res.json();
        const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${props.engineId}-${name}.json`;
        a.click();
        URL.revokeObjectURL(url);
    } catch {
        error.value = 'Network error exporting profile';
    }
}

async function importProfile() {
    if (!importName.value.trim() || !importData.value.trim()) return;
    error.value = '';
    let config: unknown;
    try {
        config = JSON.parse(importData.value);
    } catch {
        error.value = 'Invalid JSON in import data';
        return;
    }
    try {
        const res = await fetch(`/api/v1/engines/${props.engineId}/profiles`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ profileName: importName.value.trim(), config }),
        });
        if (!res.ok) {
            error.value = 'Failed to import profile';
            return;
        }
        showImport.value = false;
        importName.value = '';
        importData.value = '';
        await loadProfiles();
    } catch {
        error.value = 'Network error importing profile';
    }
}

function handleFileImport(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
        importData.value = reader.result as string;
        // Auto-fill name from filename
        if (!importName.value) {
            importName.value = file.name.replace(/\.json$/, '').replace(/^.*-/, '');
        }
    };
    reader.readAsText(file);
}

onMounted(loadProfiles);
</script>

<template>
    <div class="p-6 max-w-2xl">
        <div class="flex items-center justify-between mb-5">
            <div>
                <h1 class="text-xl font-semibold text-foreground">Profiles</h1>
                <p class="text-xs mt-0.5 text-muted">
                    {{ engine?.name ?? props.engineId }}
                </p>
            </div>
            <div class="flex gap-2">
                <MrButton size="sm" variant="secondary" @click="showImport = true">Import</MrButton>
                <MrButton size="sm" @click="showCreate = true">New Profile</MrButton>
            </div>
        </div>

        <!-- Error banner -->
        <div
            v-if="error"
            class="mb-4 px-4 py-2 rounded-lg text-sm flex items-center justify-between"
            :style="{
                backgroundColor: 'rgba(248, 113, 113, 0.15)',
                color: '#f87171',
                border: '1px solid rgba(248, 113, 113, 0.3)',
            }"
        >
            <span>{{ error }}</span>
            <button @click="error = ''" class="ml-2 text-xs opacity-70 hover:opacity-100">
                Dismiss
            </button>
        </div>

        <!-- Profile list -->
        <div class="space-y-2">
            <div v-for="p in profiles" :key="p.profile_name">
                <div
                    class="flex items-center justify-between px-4 py-3 rounded-lg bg-card border"
                    :class="
                        engine?.activeProfile === p.profile_name ? 'border-accent' : 'border-border'
                    "
                >
                    <div class="flex items-center gap-2.5">
                        <div
                            class="w-2 h-2 rounded-full shrink-0"
                            :class="
                                engine?.activeProfile === p.profile_name ? 'bg-accent' : 'bg-border'
                            "
                        />
                        <span class="text-sm font-medium text-foreground">
                            {{ p.profile_name }}
                        </span>
                        <span
                            v-if="engine?.activeProfile === p.profile_name"
                            class="text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase bg-accent-muted text-accent"
                        >
                            Live
                        </span>
                    </div>
                    <div class="flex items-center gap-1.5">
                        <MrButton
                            size="sm"
                            variant="secondary"
                            @click="loadHistory(p.profile_name)"
                        >
                            History
                        </MrButton>
                        <MrButton
                            size="sm"
                            variant="secondary"
                            @click="exportProfile(p.profile_name)"
                        >
                            Export
                        </MrButton>
                        <MrButton
                            v-if="engine?.activeProfile !== p.profile_name"
                            size="sm"
                            variant="secondary"
                            @click="showSwitchConfirm = p.profile_name"
                        >
                            Activate
                        </MrButton>
                        <MrButton
                            v-if="engine?.activeProfile !== p.profile_name"
                            size="sm"
                            variant="danger"
                            @click="showDeleteConfirm = p.profile_name"
                        >
                            Delete
                        </MrButton>
                    </div>
                </div>

                <!-- Version history (expandable) -->
                <div
                    v-if="showHistory === p.profile_name && history.length > 0"
                    class="px-4 py-2 space-y-1 -mt-1 rounded-b-lg bg-surface-alt border border-border border-t-0"
                >
                    <div class="text-[10px] font-semibold uppercase tracking-wider mb-1 text-muted">
                        Version History
                    </div>
                    <div
                        v-for="v in history"
                        :key="v.id"
                        class="flex items-center justify-between py-1.5 text-xs border-b border-border-alt"
                    >
                        <div>
                            <span class="text-subtle">{{
                                new Date(v.saved_at).toLocaleString()
                            }}</span>
                        </div>
                        <div class="flex gap-1.5">
                            <button
                                @click="previewVersion = { id: v.id, config: v.config }"
                                class="text-[10px] px-1.5 py-0.5 rounded transition-colors text-accent bg-accent-muted"
                            >
                                Preview
                            </button>
                            <button
                                @click="showRollbackConfirm = v.id"
                                class="text-[10px] px-1.5 py-0.5 rounded transition-colors text-warning"
                            >
                                Rollback
                            </button>
                        </div>
                    </div>
                    <div v-if="history.length === 0" class="text-xs py-2 text-muted">
                        No version history
                    </div>
                </div>
            </div>
            <!-- close wrapper per profile -->
        </div>

        <div v-if="profiles.length === 0" class="text-center py-16 text-muted">
            <p class="text-sm">No profiles yet</p>
            <MrButton size="sm" class="mt-3" @click="showCreate = true"
                >Create your first profile</MrButton
            >
        </div>
    </div>

    <!-- Create modal -->
    <MrModal v-if="showCreate" title="New Profile" @close="showCreate = false">
        <MrInput
            v-model="newProfileName"
            label="Profile Name"
            placeholder="e.g. Production"
            @keyup.enter="createProfile"
        />
        <template #footer>
            <MrButton variant="secondary" @click="showCreate = false">Cancel</MrButton>
            <MrButton @click="createProfile" :disabled="!newProfileName.trim()">Create</MrButton>
        </template>
    </MrModal>

    <!-- Switch confirmation -->
    <MrModal v-if="showSwitchConfirm" title="Activate Profile" @close="showSwitchConfirm = null">
        <p class="text-sm text-subtle">
            Switch to profile <strong class="text-foreground">{{ showSwitchConfirm }}</strong
            >?
        </p>
        <p v-if="engine?.running" class="text-xs mt-2 px-3 py-2 rounded bg-warning text-black">
            The engine is running and will be stopped before switching.
        </p>
        <template #footer>
            <MrButton variant="secondary" @click="showSwitchConfirm = null">Cancel</MrButton>
            <MrButton @click="switchProfile(showSwitchConfirm!)">Activate</MrButton>
        </template>
    </MrModal>

    <!-- Delete confirmation -->
    <MrModal v-if="showDeleteConfirm" title="Delete Profile" @close="showDeleteConfirm = null">
        <p class="text-sm text-subtle">
            Delete profile <strong class="text-foreground">{{ showDeleteConfirm }}</strong
            >? This cannot be undone.
        </p>
        <template #footer>
            <MrButton variant="secondary" @click="showDeleteConfirm = null">Cancel</MrButton>
            <MrButton variant="danger" @click="deleteProfile(showDeleteConfirm!)">Delete</MrButton>
        </template>
    </MrModal>

    <!-- Version preview modal -->
    <MrModal v-if="previewVersion" title="Version Preview" @close="previewVersion = null">
        <pre class="text-[10px] p-3 rounded max-h-64 overflow-auto bg-surface-alt text-muted">{{
            typeof previewVersion.config === 'string'
                ? previewVersion.config
                : JSON.stringify(JSON.parse(previewVersion.config), null, 2)
        }}</pre>
        <template #footer>
            <MrButton variant="secondary" @click="previewVersion = null">Close</MrButton>
            <MrButton @click="showRollbackConfirm = previewVersion.id"
                >Rollback to this version</MrButton
            >
        </template>
    </MrModal>

    <!-- Rollback confirmation -->
    <MrModal v-if="showRollbackConfirm" title="Rollback Config" @close="showRollbackConfirm = null">
        <p class="text-sm text-subtle">
            Restore this version? The current config will be overwritten.
        </p>
        <template #footer>
            <MrButton variant="secondary" @click="showRollbackConfirm = null">Cancel</MrButton>
            <MrButton variant="danger" @click="rollback(showRollbackConfirm!)">Rollback</MrButton>
        </template>
    </MrModal>

    <!-- Import modal -->
    <MrModal v-if="showImport" title="Import Profile" @close="showImport = false">
        <div class="space-y-3">
            <MrInput v-model="importName" label="Profile Name" placeholder="e.g. Imported Config" />
            <div>
                <label class="block text-xs font-medium mb-1 text-foreground">
                    Upload JSON file
                </label>
                <input
                    type="file"
                    accept=".json"
                    @change="handleFileImport"
                    class="text-xs text-subtle"
                />
            </div>
            <div v-if="importData">
                <label class="block text-xs font-medium mb-1 text-foreground">Preview</label>
                <pre
                    class="text-[10px] p-2 rounded max-h-32 overflow-auto bg-surface-alt text-muted"
                    >{{ importData.substring(0, 500)
                    }}{{ importData.length > 500 ? '...' : '' }}</pre
                >
            </div>
        </div>
        <template #footer>
            <MrButton variant="secondary" @click="showImport = false">Cancel</MrButton>
            <MrButton @click="importProfile" :disabled="!importName.trim() || !importData.trim()"
                >Import</MrButton
            >
        </template>
    </MrModal>
</template>
