import { ref, computed, watch, type ComputedRef } from 'vue';
import type { EngineState } from '@/stores/engines';
import type { MenuItem } from '@/components/common/MrContextMenu.vue';
import { originOf, type CrossRefs } from '@/composables/useCrossRefs';
import { buildXrefMenuItems, portLabelKey } from '@/utils/xrefMenuItems';
import { compactPortLabel } from '@/utils/portDisplay';

/** What the tag UI hands back to the editor's existing panels and editors. */
export interface XrefUiHooks {
    /** The connection's channel map editor (`channelMapEdge`). */
    channelMap: (connectionId: string) => void;
    /** The connection's label editor (`editingEdgeLabel`). */
    editLabel: (connectionId: string) => void;
    /** The side panel's bound-module link: show that module and its settings. */
    openModule: (moduleId: string) => void;
    /** The module settings panel gives way when a tag's panel opens (same place on screen). */
    closeModulePanel: () => void;
}

/**
 * The cross-reference tags' own UI (ADR-0030): the dropdown a tap opens
 * (XrefNode `open`, or a click on the tag's stub) and the side panel
 * (double-click, or "Settings…"). The link picker and the unlink confirm
 * come from useCrossRefs and are shown by the same overlay (XrefOverlays.vue).
 */
export function useXrefUi(
    engine: ComputedRef<EngineState | undefined>,
    crossRefs: CrossRefs,
    hooks: XrefUiHooks,
) {
    const tagMenu = ref<{ x: number; y: number; key: string } | null>(null);
    /** Ref key of the tag whose side panel is open. */
    const xrefPanel = ref<string | null>(null);
    const refs = computed(() => crossRefs.derived.value.refs);

    const moduleNames = computed(() =>
        Object.fromEntries(
            Object.values(engine.value?.modules ?? {}).map((m) => [m.instanceId, m.displayName]),
        ),
    );
    const portLabels = computed(() => {
        const labels: Record<string, string> = {};
        for (const m of Object.values(engine.value?.modules ?? {})) {
            for (const p of m.ports ?? [])
                labels[portLabelKey(m.instanceId, p.id)] = compactPortLabel(p);
        }
        return labels;
    });

    const tagMenuItems = computed<MenuItem[]>(() => {
        const tag = tagMenu.value ? refs.value[tagMenu.value.key] : undefined;
        if (!tag) return [];
        return buildXrefMenuItems(tag, {
            refs: refs.value,
            pageNames: crossRefs.pageNames.value,
            moduleNames: moduleNames.value,
            portLabels: portLabels.value,
            // Capacity counts every connection of the port; the picker's validator applies it.
            hasCapacity: !tag.readOnly && crossRefs.candidatesFor(originOf(tag)).length > 0,
        });
    });

    function openTagMenu(key: string, x: number, y: number) {
        tagMenu.value = { x, y, key };
    }

    /** The tag's side panel; a dropdown a slow double-click opened first closes. */
    function openPanel(key: string) {
        tagMenu.value = null;
        hooks.closeModulePanel();
        xrefPanel.value = key;
    }

    function onTagAction(action: string) {
        const open = tagMenu.value;
        tagMenu.value = null;
        const tag = open ? refs.value[open.key] : undefined;
        if (!open || !tag) return;
        // Ids after the verb may hold ':' (connection ids, ref keys).
        const at = action.indexOf(':');
        const verb = at < 0 ? action : action.slice(0, at);
        const arg = at < 0 ? '' : action.slice(at + 1);
        switch (verb) {
            case 'goto':
                crossRefs.goToRef(arg);
                break;
            case 'chmap':
                hooks.channelMap(arg);
                break;
            case 'label':
                hooks.editLabel(arg);
                break;
            case 'wire':
                crossRefs.setTagged(arg, false);
                break;
            case 'unlink':
                crossRefs.unlink(arg);
                break;
            case 'link':
                crossRefs.openLinkPicker(originOf(tag), open.x, open.y);
                break;
            case 'settings':
                openPanel(tag.key);
                break;
        }
    }

    const panelRef = computed(() => (xrefPanel.value ? refs.value[xrefPanel.value] : undefined));
    // The tag went away (unlinked, its module moved back): its panel closes.
    watch(
        () => !!xrefPanel.value && !panelRef.value,
        (gone) => gone && (xrefPanel.value = null),
    );

    function selectModule(moduleId: string) {
        xrefPanel.value = null;
        hooks.openModule(moduleId);
    }

    /** True while the dropdown, panel, picker or unlink confirm is open: canvas keys are left alone. */
    const isOpen = computed(
        () =>
            !!(
                tagMenu.value ||
                xrefPanel.value ||
                crossRefs.linkPicker.value ||
                crossRefs.pendingUnlink.value
            ),
    );

    return {
        tagMenu,
        tagMenuItems,
        xrefPanel,
        panelRef,
        refs,
        pageNames: crossRefs.pageNames,
        moduleNames,
        portLabels,
        linkPicker: crossRefs.linkPicker,
        pendingUnlink: crossRefs.pendingUnlink,
        isOpen,
        openTagMenu,
        openPanel,
        onTagAction,
        selectModule,
        setTagged: crossRefs.setTagged,
        renameRef: crossRefs.renameRef,
        goToRef: crossRefs.goToRef,
        unlink: crossRefs.unlink,
        pickLink: crossRefs.pickLink,
        confirmUnlink: crossRefs.confirmUnlink,
    };
}

export type XrefUi = ReturnType<typeof useXrefUi>;
