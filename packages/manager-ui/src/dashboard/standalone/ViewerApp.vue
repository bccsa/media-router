<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
// shared-types is CJS: named imports break under Vite's interop (see stores/engines.ts).
import * as wire from '@media-router/shared-types/browser';
import type { Dashboard } from '@media-router/shared-types';
import { createSource } from '../source';
import { useSubscription } from '../useValue';
import { viewerName } from '../paths';
import DashboardView from '../DashboardView.vue';
import DashboardMenu from '../DashboardMenu.vue';
import '../dashboard.css';

/**
 * The router's own viewer at :8081/d/ (ADR-0026): the running profile's
 * dashboards, one by name at /d/<name>. Data comes straight from this
 * router's tree, so it works with the manager down; a profile switch shows
 * the new profile's dashboard of the same name, or the list.
 */
const BASE = '/d/';
const source = createSource({ prefix: '', path: wire.ROUTER_TREE_PATH });
onUnmounted(() => source.close());
useSubscription(source, () => ['/dashboards']);

const all = computed(() => source.get<Record<string, Dashboard>>('/dashboards') ?? {});
const list = computed(() =>
    Object.entries(all.value)
        .map(([id, d]) => ({ id, name: d.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
);
const loaded = computed(() => source.loaded('/dashboards'));

const name = ref(viewerName(location.pathname, BASE));
const current = computed(() => (name.value === null ? undefined : Object.entries(all.value).find(([, d]) => d.name === name.value)));
const menuOpen = ref(false);

function open(id: string) {
    menuOpen.value = false;
    const d = all.value[id];
    if (!d) return;
    history.pushState(null, '', BASE + encodeURIComponent(d.name));
    name.value = d.name;
}

const onPop = () => (name.value = viewerName(location.pathname, BASE));
onMounted(() => window.addEventListener('popstate', onPop));
onUnmounted(() => window.removeEventListener('popstate', onPop));
</script>

<template>
    <DashboardView v-if="current" :dashboard="current[1]" :dashboard-id="current[0]" :source="source" router show-menu @menu="menuOpen = true">
        <DashboardMenu v-if="menuOpen" :dashboards="list" :current="current[0]" @pick="open" @close="menuOpen = false" />
    </DashboardView>
    <div v-else class="mr-dash theme-dark va-list">
        <h1 class="va-title">Dashboards</h1>
        <p v-if="!loaded" class="va-note">{{ source.connected.value ? 'Loading…' : 'Connecting to the router…' }}</p>
        <p v-else-if="name !== null" class="va-note">No dashboard called “{{ name }}” in the running profile.</p>
        <button v-for="d in list" :key="d.id" class="va-item" @click="open(d.id)">{{ d.name }}</button>
        <p v-if="loaded && list.length === 0" class="va-note">No dashboards yet: build one in the manager.</p>
    </div>
</template>

<style scoped>
.va-list {
    box-sizing: border-box;
    overflow: auto;
    padding: 24px;
}
.va-title {
    font-size: 22px;
    font-weight: 600;
    margin: 0 0 16px;
}
.va-note {
    color: var(--d-muted);
    margin: 0 0 12px;
}
.va-item {
    display: block;
    width: 100%;
    max-width: 480px;
    text-align: left;
    margin-bottom: 8px;
    padding: 16px;
    border-radius: 10px;
    border: 1px solid var(--d-border);
    background: var(--d-card);
    color: var(--d-text);
    font-size: 18px;
    cursor: pointer;
}
</style>
