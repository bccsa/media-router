<script setup lang="ts">
import { ref, computed } from 'vue';
import MrButton from '@/components/common/MrButton.vue';
import { useEngineStore } from '@/stores/engines';
import { patch } from '@/composables/usePatch';
import {
    getHotMember,
    isInterlockEligible,
    newInterlockId,
    INTERLOCK_DEFAULT_COLOR,
} from '@/composables/useInterlocks';

const props = defineProps<{ engineId: string }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const engineStore = useEngineStore();
const engine = computed(() => engineStore.getEngine(props.engineId));
const interlocks = computed(() => engine.value?.interlocks ?? []);

const expandedId = ref<string | null>(null);
const renamingId = ref<string | null>(null);
const renameValue = ref('');

/** Modules eligible for interlock (from plugin manifest flag). */
const eligibleModules = computed(() =>
    Object.values(engine.value?.modules ?? {}).filter(isInterlockEligible),
);

/** Map moduleId → owning interlock id (for 'already in another group' hint). */
const ownershipMap = computed(() => {
    const m = new Map<string, string>();
    for (const g of interlocks.value) {
        for (const id of g.members) m.set(id, g.id);
    }
    return m;
});

function createGroup() {
    const id = newInterlockId();
    patch.createInterlock(props.engineId, {
        id,
        name: `Group ${interlocks.value.length + 1}`,
        members: [],
        color: INTERLOCK_DEFAULT_COLOR,
    });
    expandedId.value = id;
}

function deleteGroup(id: string) {
    patch.deleteInterlock(props.engineId, id);
    if (expandedId.value === id) expandedId.value = null;
}

function toggleMember(groupId: string, moduleId: string) {
    const g = interlocks.value.find((x) => x.id === groupId);
    if (!g) return;
    const owner = ownershipMap.value.get(moduleId);
    let next: string[];
    if (g.members.includes(moduleId)) {
        next = g.members.filter((m) => m !== moduleId);
    } else if (owner && owner !== groupId) {
        // Move from other group to this one — patch both.
        patch.setInterlockMembers(
            props.engineId,
            owner,
            (interlocks.value.find((x) => x.id === owner)?.members ?? []).filter(
                (m) => m !== moduleId,
            ),
        );
        next = [...g.members, moduleId];
    } else {
        next = [...g.members, moduleId];
    }
    patch.setInterlockMembers(props.engineId, groupId, next);
}

function startRename(id: string, current: string) {
    renamingId.value = id;
    renameValue.value = current;
}

function commitRename() {
    if (renamingId.value && renameValue.value.trim()) {
        patch.renameInterlock(props.engineId, renamingId.value, renameValue.value.trim());
    }
    renamingId.value = null;
}

function onColorChange(id: string, color: string) {
    patch.recolorInterlock(props.engineId, id, color);
}

function unmuteMember(moduleId: string) {
    // The PatchRouter on the manager will cascade-mute the others.
    patch.moduleSetting(props.engineId, moduleId, 'audioEnabled', true);
}

function moduleName(id: string): string {
    return engine.value?.modules[id]?.displayName ?? id;
}
</script>

<template>
    <Teleport to="body">
        <div class="fixed inset-0 z-[998]" @click="emit('close')" />
        <div
            class="fixed top-16 right-4 w-[360px] rounded-lg shadow-xl z-[999] flex flex-col bg-card border border-border"
            style="max-height: calc(100vh - 80px)"
            @click.stop
        >
            <div
                class="flex items-center justify-between px-3 py-2 border-b border-border-alt shrink-0"
            >
                <div class="flex items-center gap-2">
                    <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                    >
                        <path
                            d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"
                        />
                    </svg>
                    <span class="font-semibold text-sm text-foreground">Interlocks</span>
                    <span class="text-[10px] text-muted">exclusive-mute groups</span>
                </div>
                <button @click="emit('close')" class="p-1 rounded text-muted">
                    <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                    >
                        <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                </button>
            </div>

            <div class="overflow-y-auto flex-1">
                <div
                    v-if="interlocks.length === 0"
                    class="px-4 py-6 text-center text-xs text-muted"
                >
                    No interlocks yet. Create a group to make only one member live at a time.
                </div>

                <div v-for="g in interlocks" :key="g.id" class="border-b border-border-alt">
                    <!-- Row header -->
                    <div class="flex items-center gap-2 px-3 py-2">
                        <label
                            class="shrink-0 relative cursor-pointer"
                            :title="`Change color (${g.color ?? INTERLOCK_DEFAULT_COLOR})`"
                        >
                            <div
                                class="w-3 h-3 rounded-full border border-border"
                                :style="{ backgroundColor: g.color ?? INTERLOCK_DEFAULT_COLOR }"
                            />
                            <input
                                type="color"
                                class="absolute inset-0 opacity-0 w-full h-full cursor-pointer"
                                :value="g.color ?? INTERLOCK_DEFAULT_COLOR"
                                @change="
                                    onColorChange(g.id, ($event.target as HTMLInputElement).value)
                                "
                            />
                        </label>
                        <input
                            v-if="renamingId === g.id"
                            v-model="renameValue"
                            @keydown.enter="commitRename"
                            @blur="commitRename"
                            class="flex-1 px-1.5 py-0.5 text-xs rounded bg-input border border-border text-foreground"
                        />
                        <button
                            v-else
                            @click="startRename(g.id, g.name)"
                            class="flex-1 text-left text-xs font-medium truncate text-foreground"
                        >
                            {{ g.name }}
                        </button>
                        <span class="text-[10px] text-muted shrink-0"
                            >{{ g.members.length }} members</span
                        >
                        <button
                            @click="expandedId = expandedId === g.id ? null : g.id"
                            class="p-1 rounded text-muted"
                        >
                            <svg
                                width="12"
                                height="12"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="2"
                                :style="{ transform: expandedId === g.id ? 'rotate(180deg)' : '' }"
                            >
                                <path d="M6 9l6 6 6-6" />
                            </svg>
                        </button>
                        <button
                            @click="deleteGroup(g.id)"
                            class="p-1 rounded text-error opacity-60 hover:opacity-100"
                        >
                            <svg
                                width="12"
                                height="12"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="2"
                            >
                                <path
                                    d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"
                                />
                            </svg>
                        </button>
                    </div>

                    <!-- Hot indicator -->
                    <div class="px-3 pb-1 text-[10px] text-subtle" v-if="g.members.length > 0">
                        Live:
                        <span v-if="getHotMember(engine, g)" class="text-ok">
                            {{ getHotMember(engine, g)?.displayName }}
                        </span>
                        <span v-else class="text-muted">— (all muted)</span>
                    </div>

                    <!-- Expanded: member editor -->
                    <div v-if="expandedId === g.id" class="px-3 pb-3">
                        <div class="text-[10px] uppercase tracking-wider text-muted py-1">
                            Eligible modules
                        </div>
                        <div v-if="eligibleModules.length === 0" class="text-xs text-muted py-1">
                            No interlock-eligible modules on this engine.
                        </div>
                        <div
                            v-for="mod in eligibleModules"
                            :key="mod.instanceId"
                            class="flex items-center gap-2 py-1 text-xs"
                        >
                            <input
                                type="checkbox"
                                :checked="g.members.includes(mod.instanceId)"
                                @change="toggleMember(g.id, mod.instanceId)"
                                class="shrink-0"
                            />
                            <button
                                @click="unmuteMember(mod.instanceId)"
                                :disabled="!g.members.includes(mod.instanceId)"
                                class="flex-1 text-left truncate text-foreground disabled:opacity-40"
                            >
                                {{ mod.displayName }}
                            </button>
                            <span
                                v-if="
                                    g.members.includes(mod.instanceId) &&
                                    mod.settings?.audioEnabled !== false
                                "
                                class="text-[10px] text-ok shrink-0"
                                >LIVE</span
                            >
                            <span
                                v-else-if="
                                    ownershipMap.get(mod.instanceId) &&
                                    ownershipMap.get(mod.instanceId) !== g.id
                                "
                                class="text-[10px] text-muted shrink-0"
                                >in other group</span
                            >
                        </div>
                    </div>
                </div>
            </div>

            <div class="border-t border-border-alt p-2 shrink-0">
                <MrButton size="sm" class="w-full" @click="createGroup">+ New Interlock</MrButton>
            </div>
        </div>
    </Teleport>
</template>
