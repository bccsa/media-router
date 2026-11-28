import { ref, getCurrentInstance, onUnmounted, type ComputedRef } from 'vue';
import { useVueFlow } from '@vue-flow/core';
import type { EngineState } from '@/stores/engines';
import type { Pages } from '@/composables/usePages';
import { tagPlace, TAG_SIZE } from '@/utils/xrefCanvas';
import type { DerivedRefs, RefNode } from '@/utils/crossRefTypes';

/** How long a tag reached through a jump glows, ms. */
export const HIGHLIGHT_MS = 1600;

/**
 * The jump to a cross-reference tag (ADR-0030): its page, the view centred on
 * it, a brief glow. On another page the tag's module is not on the canvas yet,
 * so the first centring is a guess (the module's mid-height, whatever the
 * port); once that module is measured, while the tag still glows, the view
 * centres again on the tag's real place.
 * `keepViewOnPageChange` stops the page fit the switch would otherwise do.
 */
export function useRefJump(
    engine: ComputedRef<EngineState | undefined>,
    derived: ComputedRef<DerivedRefs>,
    pages: Pick<Pages, 'currentPage' | 'selectPage'>,
    keepViewOnPageChange: () => void,
) {
    const { setCenter, findNode, onNodesInitialized } = useVueFlow();
    const highlighted = ref<string | null>(null);
    let glow: ReturnType<typeof setTimeout> | null = null;
    /** A tag jumped to on another page, centred again once its module is measured. */
    let settling: string | null = null;
    if (getCurrentInstance()) onUnmounted(() => glow && clearTimeout(glow));

    function centreOn(tag: RefNode) {
        const at = tagPlace(tag, findNode, engine.value?.modules[tag.moduleId]?.position);
        const size = findNode(tag.key)?.dimensions;
        setCenter(
            at.x + (size?.width || TAG_SIZE.width) / 2,
            at.y + (size?.height || TAG_SIZE.height) / 2,
            { zoom: 1, duration: 300 },
        );
    }

    /** Show tag `key`: its page, centred, glowing briefly. */
    function goToRef(key: string) {
        const tag = derived.value.refs[key];
        if (!tag) return;
        const away = tag.page !== pages.currentPage.value;
        if (away) {
            keepViewOnPageChange();
            pages.selectPage(tag.page);
        }
        centreOn(tag);
        settling = away ? key : null;
        highlighted.value = key;
        if (glow) clearTimeout(glow);
        glow = setTimeout(() => {
            highlighted.value = null;
            glow = null;
            settling = null;
        }, HIGHLIGHT_MS);
    }

    // The shown page's nodes are measured: centre on the tag's real place.
    onNodesInitialized(() => {
        const tag = settling ? derived.value.refs[settling] : undefined;
        if (!tag || !findNode(tag.moduleId)?.dimensions?.width) return;
        settling = null;
        centreOn(tag);
    });

    return { highlighted, goToRef };
}
