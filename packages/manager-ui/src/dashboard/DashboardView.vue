<script setup lang="ts">
import { computed, provide, ref } from 'vue';
import { Menu } from 'lucide-vue-next';
import type { Dashboard } from '@media-router/shared-types';
import DashboardGrid from './DashboardGrid.vue';
import WidgetHost from './WidgetHost.vue';
import { rectOf } from './grid';
import type { DashboardSource } from './source';
import { useLinkStatus } from './useLinkStatus';
import { useTimed } from './useTimed';
import { ASK, DASHBOARD_ID, THEME } from './keys';
import './dashboard.css';

const props = defineProps<{
    dashboard: Dashboard;
    source: DashboardSource;
    /** The router behind the source is known to be down. */
    offline?: boolean;
    editing?: boolean;
    /** Offer the dashboard menu (never on a locked dashboard). */
    showMenu?: boolean;
    /** Served by the router itself: the dot also watches its manager link. */
    router?: boolean;
    /** Its id where it is stored: buttons run their scripts there. */
    dashboardId?: string;
}>();
const emit = defineEmits<{ menu: [] }>();

const status = useLinkStatus({
    source: props.source,
    dashboard: () => props.dashboard,
    offline: () => !!props.offline,
    router: () => !!props.router,
});

// A tap on the dot says why it has its colour (touch panels have no hover).
const { value: showReason, set: setReason } = useTimed(false, 5000);
const toggleReason = () => setReason(!showReason.value);

provide(THEME, computed(() => props.dashboard.theme));
provide(DASHBOARD_ID, computed(() => props.dashboardId));

// Widgets' confirmations, as one readable popup over the whole dashboard.
const asking = ref<{ question: string; detail?: string; resolve: (yes: boolean) => void } | null>(null);
provide(ASK, (question, detail) => {
    asking.value?.resolve(false);
    return new Promise((resolve) => (asking.value = { question, detail, resolve }));
});
function answer(yes: boolean) {
    const a = asking.value;
    asking.value = null;
    a?.resolve(yes);
}
// No zoom while editing: drags move widgets.
const grid = computed(() => (props.editing ? { ...props.dashboard, zoom: false } : props.dashboard));
</script>

<template>
    <div class="mr-dash" :class="`theme-${dashboard.theme}`">
        <DashboardGrid :dashboard="grid">
            <template #default="{ metrics }">
                <WidgetHost
                    v-for="w in dashboard.widgets"
                    :key="w.id"
                    :widget="w"
                    :rect="rectOf(w, metrics)"
                    :source="source"
                    :offline="!!offline"
                    :editing="editing"
                />
                <slot name="overlay" :metrics="metrics" />
            </template>
        </DashboardGrid>
        <button class="dv-dot-hit" :aria-label="status.reason" @click="toggleReason">
            <span class="dv-dot" :class="`dv-${status.level}`" />
        </button>
        <div v-if="showReason" class="dv-reason" :class="`dv-${status.level}`" @click="setReason(false)">{{ status.reason }}</div>
        <button v-if="showMenu && !dashboard.locked && !editing" class="dv-menu" aria-label="Dashboards" @click="emit('menu')">
            <Menu :size="14" />
        </button>
        <div v-if="asking" class="dv-modal" @click.self="answer(false)">
            <div class="dv-dialog" role="alertdialog">
                <p class="dv-q">{{ asking.question }}</p>
                <p v-if="asking.detail" class="dv-detail">{{ asking.detail }}</p>
                <div class="dv-actions">
                    <button class="dv-no" @click="answer(false)">Cancel</button>
                    <button class="dv-yes" @click="answer(true)">Yes</button>
                </div>
            </div>
        </div>
        <slot />
    </div>
</template>

<style scoped>
.dv-dot-hit {
    position: absolute;
    top: 0;
    right: 0;
    z-index: 10;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: pointer;
}
.dv-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
}
.dv-dot.dv-ok {
    background: var(--d-ok);
}
.dv-dot.dv-degraded {
    background: var(--d-warning);
    box-shadow: 0 0 8px var(--d-warning);
}
.dv-dot.dv-down {
    background: var(--d-error);
    box-shadow: 0 0 8px var(--d-error);
}
.dv-reason {
    position: absolute;
    top: 26px;
    right: 6px;
    z-index: 11;
    max-width: min(280px, 80%);
    padding: 6px 9px;
    border-radius: 7px;
    border: 1px solid var(--d-border);
    border-left: 3px solid var(--d-ok);
    background: var(--d-card);
    color: var(--d-text);
    font-size: 12px;
    line-height: 1.35;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
}
.dv-reason.dv-degraded {
    border-left-color: var(--d-warning);
}
.dv-reason.dv-down {
    border-left-color: var(--d-error);
}
.dv-modal {
    position: absolute;
    inset: 0;
    z-index: 20;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    background: rgba(0, 0, 0, 0.45);
}
.dv-dialog {
    width: min(360px, 100%);
    padding: 16px;
    border-radius: 10px;
    border: 1px solid var(--d-border);
    background: var(--d-card);
    color: var(--d-text);
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
}
.dv-q {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
}
.dv-detail {
    margin: 6px 0 0;
    font-size: 13px;
    line-height: 1.4;
    color: var(--d-muted);
}
.dv-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 16px;
}
.dv-actions button {
    min-width: 88px;
    min-height: 40px;
    padding: 0 16px;
    border-radius: 7px;
    border: 1px solid var(--d-border);
    background: var(--d-track);
    color: var(--d-text);
    font-size: 15px;
    cursor: pointer;
}
.dv-actions .dv-yes {
    border-color: var(--d-warning);
    color: var(--d-warning);
    font-weight: 600;
}
/* Beside the dot, top right: widget titles start top left. */
.dv-menu {
    position: absolute;
    top: 2px;
    right: 28px;
    z-index: 10;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 7px;
    border: 1px solid var(--d-border);
    background: var(--d-card);
    color: var(--d-text);
    opacity: 0.55;
    cursor: pointer;
}
.dv-menu:hover {
    opacity: 1;
}
</style>
