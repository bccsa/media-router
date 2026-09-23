<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useSocketStore } from '@/stores/socket';
import { useEngineStore } from '@/stores/engines';
import { useToast } from '@/composables/useToast';
import MrInput from '@/components/common/MrInput.vue';
import MrButton from '@/components/common/MrButton.vue';
import type { DgramListener, ManagerSettings } from '@media-router/shared-types';

/**
 * The UDP ports engines connect to the manager on (issue #692). One is the
 * minimum; extra ports give engines with several paths a second door in.
 * Saved to manager.db over `settings:set` and applied live.
 */
const socket = useSocketStore();
const toast = useToast();
const engineStore = useEngineStore();

/** Engines currently reaching the manager through a given listener port. */
function enginesOn(port: number): string[] {
    return engineStore.engineList
        .filter((e) => e.online && e.paths?.some((p) => p.listenerPort === port))
        .map((e) => e.name || e.engineId)
        .sort();
}

const rows = ref<DgramListener[]>([]);
const saved = ref<DgramListener[]>([]);
const loading = ref(true);
const saving = ref(false);

const key = (l: DgramListener) => `${l.bindAddress ?? ''}:${l.port}`;
const dirty = computed(() => rows.value.map(key).join(',') !== saved.value.map(key).join(','));
const removed = computed(() =>
    saved.value.filter((s) => !rows.value.some((r) => key(r) === key(s))),
);
const duplicate = computed(() => new Set(rows.value.map((r) => r.port)).size !== rows.value.length);
const invalid = computed(
    () =>
        duplicate.value ||
        rows.value.some(
            (r) =>
                !Number.isInteger(r.port) ||
                r.port < 1 ||
                r.port > 65535 ||
                (r.bindAddress !== undefined && !/^\d{1,3}(\.\d{1,3}){3}$/.test(r.bindAddress)),
        ),
);

function clone(list: DgramListener[]): DgramListener[] {
    return list.map((l) => ({
        port: l.port,
        ...(l.bindAddress ? { bindAddress: l.bindAddress } : {}),
    }));
}

async function load() {
    loading.value = true;
    try {
        const s = await socket.request<ManagerSettings>('settings:get');
        saved.value = clone(s.dgramListeners);
        rows.value = clone(s.dgramListeners);
    } catch (err) {
        toast.show(`Could not load listeners: ${(err as Error).message}`);
    } finally {
        loading.value = false;
    }
}

function add() {
    const used = new Set(rows.value.map((r) => r.port));
    let port = 3000;
    while (used.has(port)) port++;
    rows.value = [...rows.value, { port }];
}

function remove(i: number) {
    if (rows.value.length <= 1) return;
    rows.value = rows.value.filter((_, idx) => idx !== i);
}

function setAddress(i: number, value: string | number) {
    const v = String(value).trim();
    const next = [...rows.value];
    next[i] = { port: next[i].port, ...(v ? { bindAddress: v } : {}) };
    rows.value = next;
}

function setPort(i: number, value: string | number) {
    const next = [...rows.value];
    next[i] = { ...next[i], port: Number(value) };
    rows.value = next;
}

async function apply() {
    saving.value = true;
    try {
        const s = await socket.request<ManagerSettings>(
            'settings:set',
            { dgramListeners: clone(rows.value) },
            { timeoutMs: 20_000 },
        );
        saved.value = clone(s.dgramListeners);
        rows.value = clone(s.dgramListeners);
        toast.show('Listeners applied — engines reconnect within a few seconds', 'info');
    } catch (err) {
        toast.show((err as Error).message);
    } finally {
        saving.value = false;
    }
}

function reset() {
    rows.value = clone(saved.value);
}

onMounted(load);
</script>

<template>
    <div class="rounded-lg overflow-hidden bg-card border border-border">
        <div
            class="px-5 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted border-b border-border-alt"
        >
            Engine Comms
        </div>
        <div class="px-5 py-4 space-y-3">
            <p class="text-[11px] text-muted">
                UDP ports engines connect on. Add a port per network path; leave the address empty
                to listen on all interfaces. Firewall rules on this host must allow each port.
            </p>

            <div v-if="loading" class="text-xs text-muted">Loading…</div>

            <div v-else class="space-y-2">
                <div
                    v-for="(row, i) in rows"
                    :key="i"
                    class="grid grid-cols-[1fr_1.4fr_auto] gap-2 items-end"
                    data-test="listener-row"
                >
                    <MrInput
                        :model-value="row.port"
                        type="number"
                        :min="1"
                        :max="65535"
                        :label="i === 0 ? 'UDP port' : undefined"
                        @update:model-value="setPort(i, $event)"
                    />
                    <MrInput
                        :model-value="row.bindAddress ?? ''"
                        type="text"
                        placeholder="all interfaces"
                        :label="i === 0 ? 'Bind address' : undefined"
                        @update:model-value="setAddress(i, $event)"
                    />
                    <MrButton
                        variant="secondary"
                        size="sm"
                        :disabled="rows.length <= 1"
                        data-test="remove"
                        @click="remove(i)"
                    >
                        Remove
                    </MrButton>
                    <p
                        v-if="enginesOn(row.port).length"
                        class="col-span-3 text-[11px] text-muted -mt-1"
                        data-test="engines-on"
                    >
                        <span class="text-foreground">{{ enginesOn(row.port).length }}</span>
                        connected: {{ enginesOn(row.port).join(', ') }}
                    </p>
                </div>

                <div class="flex items-center gap-2 pt-1">
                    <MrButton variant="secondary" size="sm" data-test="add" @click="add">
                        Add port
                    </MrButton>
                    <span class="flex-1" />
                    <MrButton
                        v-if="dirty"
                        variant="secondary"
                        size="sm"
                        data-test="reset"
                        @click="reset"
                    >
                        Reset
                    </MrButton>
                    <MrButton
                        size="sm"
                        :disabled="!dirty || invalid || saving"
                        :loading="saving"
                        data-test="apply"
                        @click="apply"
                    >
                        Apply
                    </MrButton>
                </div>

                <p v-if="duplicate" class="text-[11px] text-error" data-test="dup-warning">
                    Two rows share the same port. A wildcard and a specific address cannot share a
                    port either.
                </p>
                <p
                    v-else-if="removed.length"
                    class="text-[11px] text-warning"
                    data-test="remove-warning"
                >
                    Removing
                    <span class="font-mono">{{
                        removed.map((l) => `${l.bindAddress ?? '*'}:${l.port}`).join(', ')
                    }}</span>
                    drops engines that only reach the manager through it until they retry. Engines
                    with another path stay connected.
                </p>
                <p v-else-if="dirty" class="text-[11px] text-muted">
                    Applying rebinds the manager. Every engine reconnects within a few seconds.
                </p>
            </div>
        </div>
    </div>
</template>
