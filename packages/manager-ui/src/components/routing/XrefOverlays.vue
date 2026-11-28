<script setup lang="ts">
/**
 * The cross-reference tags' overlays (ADR-0030): the tag dropdown, the tag's
 * side panel, the link picker and the unlink confirm. Mounted by
 * RoutingOverlays, which counts them in `isBlocked` (`xref.isOpen`).
 */
import type { UnwrapNestedRefs } from 'vue';
import MrContextMenu from '@/components/common/MrContextMenu.vue';
import MrButton from '@/components/common/MrButton.vue';
import MrModal from '@/components/common/MrModal.vue';
import XrefSettingsPanel from './XrefSettingsPanel.vue';
import XrefLinkPicker from './XrefLinkPicker.vue';
import type { XrefUi } from '@/composables/useXrefUi';

defineProps<{
    /** `reactive(useXrefUi(…))`. */
    xref: UnwrapNestedRefs<XrefUi>;
}>();
</script>

<template>
    <MrContextMenu
        v-if="xref.tagMenu"
        :items="xref.tagMenuItems"
        :x="xref.tagMenu.x"
        :y="xref.tagMenu.y"
        @action="xref.onTagAction"
        @close="xref.tagMenu = null"
    />

    <XrefSettingsPanel
        v-if="xref.panelRef"
        :ref-node="xref.panelRef"
        :page-names="xref.pageNames"
        :module-names="xref.moduleNames"
        :port-labels="xref.portLabels"
        :refs="xref.refs"
        @close="xref.xrefPanel = null"
        @rename="xref.renameRef"
        @goto="xref.goToRef"
        @unlink="xref.unlink"
        @select-module="xref.selectModule"
    />

    <XrefLinkPicker
        v-if="xref.linkPicker"
        :x="xref.linkPicker.x"
        :y="xref.linkPicker.y"
        :candidates="xref.linkPicker.candidates"
        @pick="xref.pickLink"
        @close="xref.linkPicker = null"
    />

    <MrModal v-if="xref.pendingUnlink" title="Unlink?" @close="xref.pendingUnlink = null">
        <p class="text-sm text-subtle">
            {{ xref.pendingUnlink.from }} → {{ xref.pendingUnlink.to }}
        </p>
        <p class="text-sm text-subtle mt-2">The connection between them will be removed.</p>
        <template #footer>
            <MrButton size="sm" variant="secondary" @click="xref.pendingUnlink = null"
                >Cancel</MrButton
            >
            <MrButton size="sm" variant="danger" @click="xref.confirmUnlink">Unlink</MrButton>
        </template>
    </MrModal>
</template>
