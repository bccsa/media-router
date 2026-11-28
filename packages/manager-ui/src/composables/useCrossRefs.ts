import { ref, computed, type ComputedRef } from 'vue';
import type { XYPosition } from '@vue-flow/core';
// shared-types is CJS: a namespace import is the safe interop (see stores/engines.ts).
import * as shared from '@media-router/shared-types';
import type { PatchOp } from '@media-router/shared-types';
import type { EngineState } from '@/stores/engines';
import { patch } from '@/composables/usePatch';
import { useToast } from '@/composables/useToast';
import { connectPorts, type PortRef } from '@/composables/useGraphConnect';
import { useRefRecords } from '@/composables/useRefRecords';
import { useRefJump } from '@/composables/useRefJump';
import type { Pages } from '@/composables/usePages';
import {
    deriveRefs,
    directOnPage,
    pageNamesOf,
    pageOf,
    refsOnPage,
    stubsOnPage,
} from '@/utils/crossRefs';
import { linkCandidates, type LinkOrigin } from '@/utils/crossRefCandidates';
import { compactPortLabel } from '@/utils/portDisplay';
import { tagAtDrop } from '@/utils/xrefCanvas';
import type { DerivedRefs, LinkCandidate, RefNode } from '@/utils/crossRefTypes';

const { refKey } = shared;

export type CrossRefPages = Pick<Pages, 'currentPage' | 'selectPage'>;

/** The open link picker: screen point, the port it links from, and where a new near tag goes. */
export interface LinkPickerState {
    x: number;
    y: number;
    origin: LinkOrigin;
    candidates: LinkCandidate[];
    /** Flow point of a wire dropped on the canvas; the port's new tag is placed there. */
    dropAt?: XYPosition;
}

/** A link awaiting the unlink confirm, both ends named. */
export interface PendingUnlink {
    connectionId: string;
    from: string;
    to: string;
}

const noRefs = (): DerivedRefs => ({ directConnectionIds: [], links: [], refs: {} });

/** The port a tag sits at, as the link picker's origin. */
export const originOf = (tag: RefNode): LinkOrigin => ({
    moduleId: tag.moduleId,
    portId: tag.portId,
    direction: tag.kind === 'out' ? 'output' : 'input',
});

/**
 * The routing editor's cross-reference tags for one engine (ADR-0030): the
 * tags and wires of the current page, the tag records pass (useRefRecords),
 * the jump to a tag (useRefJump), the link picker, and the link, unlink, tag,
 * rename and position writes.
 * `keepViewOnPageChange` stops the page fit when a jump centres the view.
 */
export function useCrossRefs(
    engineId: () => string,
    engine: ComputedRef<EngineState | undefined>,
    pages: CrossRefPages,
    keepViewOnPageChange: () => void = () => {},
) {
    const toast = useToast();

    const editor = computed(() => engine.value?.editor);
    const pageNames = computed(() => pageNamesOf(editor.value));
    const derived = computed(() => {
        const eng = engine.value;
        if (!eng) return noRefs();
        return deriveRefs(eng.modules, eng.connections ?? [], eng.editor, pageNames.value);
    });
    const page = () => pages.currentPage.value;
    const pageRefs = computed(() => refsOnPage(derived.value, page()));
    const pageStubs = computed(() => stubsOnPage(derived.value, page()));
    const pageDirect = computed(() => {
        const eng = engine.value;
        return eng ? directOnPage(derived.value, eng.connections ?? [], eng.editor, page()) : [];
    });
    useRefRecords(engineId, derived, () => editor.value);
    const { highlighted, goToRef } = useRefJump(engine, derived, pages, keepViewOnPageChange);

    // --- Linking ---
    const linkPicker = ref<LinkPickerState | null>(null);

    function candidatesFor(origin: LinkOrigin): LinkCandidate[] {
        const eng = engine.value;
        return eng ? linkCandidates(eng, eng.editor, origin) : [];
    }

    /** Open the picker for `origin` at a screen point. With one page there is nowhere to link to. */
    function openLinkPicker(origin: LinkOrigin, x: number, y: number, dropAt?: XYPosition) {
        if (Object.keys(editor.value?.pages ?? {}).length < 2) return;
        linkPicker.value = { x, y, origin, candidates: candidatesFor(origin), dropAt };
    }

    function pickLink(candidate: LinkCandidate) {
        const open = linkPicker.value;
        linkPicker.value = null;
        if (open) linkPorts(open.origin, candidate, open.dropAt);
    }

    /**
     * Connect `from` to a port on another page. A port with no tag yet gets
     * its new tag at `dropAt`; one that has a tag keeps it, and the link joins it.
     */
    function linkPorts(from: LinkOrigin, to: PortRef, dropAt?: XYPosition): boolean {
        const kind = from.direction === 'output' ? 'out' : 'in';
        const near = refKey(kind, from.moduleId, from.portId);
        const fresh = !derived.value.refs[near];
        const verdict = connectPorts(engineId(), from, to);
        if (!verdict.ok) {
            toast.show(verdict.reason);
            return false;
        }
        // A field add: the manager numbers the record if the numbering pass hasn't yet.
        if (dropAt && fresh) {
            const value = tagAtDrop(kind, dropAt);
            patch.editor(engineId(), [{ op: 'add', path: `/editor/refs/${near}/pos`, value }]);
        }
        return true;
    }

    // --- Unlinking (explicit only, confirmed) ---
    const pendingUnlink = ref<PendingUnlink | null>(null);

    function endLabel(moduleId: string, portId: string): string {
        const mod = engine.value?.modules[moduleId];
        const port = mod?.ports?.find((p) => p.id === portId);
        const label = `${mod?.displayName ?? moduleId}/${port ? compactPortLabel(port) : portId}`;
        return `${label} (${pageNames.value[pageOf(editor.value, moduleId)]})`;
    }

    function unlink(connectionId: string) {
        const c = engine.value?.connections.find((x) => x.id === connectionId);
        if (!c) return;
        pendingUnlink.value = {
            connectionId,
            from: endLabel(c.sourceModuleId, c.sourcePortId),
            to: endLabel(c.sinkModuleId, c.sinkPortId),
        };
    }

    function confirmUnlink() {
        const pending = pendingUnlink.value;
        pendingUnlink.value = null;
        if (pending) patch.removeConnection(engineId(), pending.connectionId);
    }

    // --- Layout writes ---
    /** Draw a same-page wire as a tag pair ("Show as cross-reference"), or back as a wire. */
    function setTagged(connectionId: string, on: boolean) {
        const path = `/editor/tagged/${connectionId}`;
        patch.editor(engineId(), [on ? { op: 'add', path, value: true } : { op: 'remove', path }]);
    }

    /** null clears the name, so the number shows again. Read-only tags have no record to name. */
    function renameRef(key: string, name: string | null) {
        if (derived.value.refs[key]?.readOnly !== false) return;
        const path = `/editor/refs/${key}/name`;
        patch.editor(engineId(), [
            name ? { op: 'add', path, value: name } : { op: 'remove', path },
        ]);
    }

    /** Save dragged tags' places (one write); read-only tags are never stored. */
    function saveRefPositions(moved: Array<{ key: string; x: number; y: number }>) {
        const ops: PatchOp[] = moved
            .filter((m) => derived.value.refs[m.key]?.readOnly === false)
            .map((m) => ({
                op: 'add',
                path: `/editor/refs/${m.key}/pos`,
                value: { x: Math.round(m.x), y: Math.round(m.y) },
            }));
        if (ops.length > 0) patch.editor(engineId(), ops);
    }

    /** Ops that put the current page's dragged tags back beside their ports (Format). */
    function clearPositionOps(): PatchOp[] {
        return pageRefs.value
            .filter((r) => r.pos)
            .map((r) => ({ op: 'remove', path: `/editor/refs/${r.key}/pos` }));
    }

    return {
        derived,
        pageNames,
        pageRefs,
        pageStubs,
        pageDirect,
        highlighted,
        goToRef,
        linkPicker,
        candidatesFor,
        openLinkPicker,
        pickLink,
        linkPorts,
        pendingUnlink,
        unlink,
        confirmUnlink,
        setTagged,
        renameRef,
        saveRefPositions,
        clearPositionOps,
    };
}

export type CrossRefs = ReturnType<typeof useCrossRefs>;
