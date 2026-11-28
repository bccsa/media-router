import { ref, computed, type ComputedRef } from 'vue';
import type { EngineState } from '@/stores/engines';
import type { MenuItem } from '@/components/common/MrContextMenu.vue';
import { patch } from '@/composables/usePatch';
import { buildEdgeMenuItems } from '@/utils/moduleMenuItems';
import { STUB_EDGE_PREFIX } from '@/utils/crossRefTypes';
import { PCM } from '@/utils/crossRefs';

/** Cross-reference hooks (ADR-0030); omitted = plain wires only. */
export interface EdgeMenuRefs {
    /** A tag's stub edge was clicked: open that tag's dropdown at the pointer. */
    openTagMenu: (key: string, x: number, y: number) => void;
    setTagged: (connectionId: string, on: boolean) => void;
}

/** Wires that can be drawn as a tag pair ("Show as cross-reference"): 302M and MPEG-TS. */
const TAGGABLE = new Set(['audio/302m', 'muxed/mpegts']);
const SHOW_AS_REF: MenuItem = {
    label: 'Show as cross-reference',
    action: 'showAsRef',
    icon: '<path d="M3 6h12l4 6-4 6H3z"/>',
    tooltip: 'Draw this connection as a pair of numbered tags instead of a wire',
};

function eventPoint(e: any): { x: number; y: number } {
    return {
        x: 'clientX' in e ? e.clientX : (e.touches?.[0]?.clientX ?? 0),
        y: 'clientY' in e ? e.clientY : (e.touches?.[0]?.clientY ?? 0),
    };
}

/**
 * The connection menu: click or right-click a wire, then edit its label, open
 * its channel map, show it as a cross-reference or delete it. `onClickOpen`
 * runs when a click opens the menu, so the caller's pane-click dismiss can
 * ignore that same click. A tag's stub edge is not a connection: it opens the
 * tag's dropdown, so it can never be deleted from here.
 */
export function useEdgeMenu(
    engineId: () => string,
    engine: ComputedRef<EngineState | undefined>,
    onClickOpen: () => void,
    refs?: EdgeMenuRefs,
) {
    const edgeContextMenu = ref<{ x: number; y: number; edgeId: string } | null>(null);
    const editingEdgeLabel = ref<{ edgeId: string; label: string } | null>(null);
    const channelMapEdge = ref<string | null>(null);

    /** True (and the tag's dropdown opened) when `edgeId` is a tag's stub. */
    function openedStub(edgeId: string, event: any): boolean {
        if (!edgeId.startsWith(STUB_EDGE_PREFIX)) return false;
        const { x, y } = eventPoint(event);
        refs?.openTagMenu(edgeId.slice(STUB_EDGE_PREFIX.length), x, y);
        return true;
    }

    function onEdgeClick(payload: any) {
        if (openedStub(payload.edge.id, payload.event)) return;
        edgeContextMenu.value = { ...eventPoint(payload.event), edgeId: payload.edge.id };
        onClickOpen();
    }

    function onEdgeContextMenu(payload: any) {
        payload.event.preventDefault();
        if (openedStub(payload.edge.id, payload.event)) return;
        edgeContextMenu.value = { ...eventPoint(payload.event), edgeId: payload.edge.id };
    }

    const edgeMenuItems = computed<MenuItem[]>(() => {
        const conn = edgeContextMenu.value
            ? engine.value?.connections.find((c) => c.id === edgeContextMenu.value!.edgeId)
            : null;
        const portType = (moduleId: string, portId: string) =>
            engine.value?.modules[moduleId]?.ports?.find((p) => p.id === portId)?.streamType;
        const srcStreamType = conn ? portType(conn.sourceModuleId, conn.sourcePortId) : undefined;
        // Channel maps apply to both audio transports: pw-links re-wire per
        // the map; 302m edges render it as an audioconvert mix-matrix in the
        // consumer's decode branch.
        const items = buildEdgeMenuItems(srcStreamType === PCM || srcStreamType === 'audio/302m');
        // The menu only opens on wires drawn on the page, so both ends share it.
        const taggable =
            !!conn &&
            TAGGABLE.has(srcStreamType ?? '') &&
            TAGGABLE.has(portType(conn.sinkModuleId, conn.sinkPortId) ?? '');
        if (refs && taggable)
            items.splice(
                items.findIndex((i) => i.divider),
                0,
                SHOW_AS_REF,
            );
        return items;
    });

    function onEdgeContextAction(action: string, onDelete: (edgeId: string) => void) {
        if (!edgeContextMenu.value) return;
        const edgeId = edgeContextMenu.value.edgeId;

        switch (action) {
            case 'delete':
                onDelete(edgeId);
                break;
            case 'editLabel': {
                const conn = engine.value?.connections.find((c) => c.id === edgeId);
                editingEdgeLabel.value = { edgeId, label: conn?.label ?? '' };
                break;
            }
            case 'channelMap':
                channelMapEdge.value = edgeId;
                break;
            case 'showAsRef':
                refs?.setTagged(edgeId, true);
                break;
        }
        edgeContextMenu.value = null;
    }

    function saveEdgeLabel() {
        if (!editingEdgeLabel.value) return;
        patch.connectionField(
            engineId(),
            editingEdgeLabel.value.edgeId,
            'label',
            editingEdgeLabel.value.label || '',
        );
        editingEdgeLabel.value = null;
    }

    return {
        edgeContextMenu,
        edgeMenuItems,
        editingEdgeLabel,
        channelMapEdge,
        onEdgeClick,
        onEdgeContextMenu,
        onEdgeContextAction,
        saveEdgeLabel,
    };
}
