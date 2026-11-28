import { ref, computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { PatchOp } from '@media-router/shared-types';
import { useEngineStore } from '@/stores/engines';
import { patch } from '@/composables/usePatch';
import { useToast } from '@/composables/useToast';
import { pageNamesOf, pageResolver, sortedPages } from '@/utils/crossRefs';
import { pcmCrossing, placeOnPage, shiftRefPosOps } from '@/utils/crossRefMoves';
import {
    addPageOps,
    deletePageOps,
    hasPages,
    moveModulesOps,
    movePageOps,
    renamePageOps,
} from '@/utils/pageOps';
import type { PageTab } from '@/utils/crossRefTypes';
import { NEW_PAGE } from '@/utils/pageMenuItems';

const storageKey = (engineId: string) => `mr.routing.page.${engineId}`;

// Storage can be missing or throw (private window, blocked site data): the page then
// comes from the link or defaults to the first one.
function readStoredPage(engineId: string): string | null {
    try {
        return localStorage.getItem(storageKey(engineId));
    } catch {
        return null;
    }
}
function storePage(engineId: string, pageId: string) {
    try {
        localStorage.setItem(storageKey(engineId), pageId);
    } catch {
        // per-viewer convenience only
    }
}

/**
 * The routing editor's pages (ADR-0030) for one engine: the tabs, the page
 * this viewer is on, and the page actions, written with `patch.editor`.
 *
 * The current page is each viewer's own: `?page=<id>`, else the one last
 * picked for this engine (localStorage), else the first page. A requested
 * page that does not exist (yet, or any more) shows the first page but is
 * kept, so a link still lands once the layout arrives. The canvas
 * (useGraphNodes) fits the view when the page changes.
 */
export function usePages(engineId: () => string) {
    const store = useEngineStore();
    const route = useRoute();
    const router = useRouter();
    const toast = useToast();

    const engine = computed(() => store.getEngine(engineId()));
    const editor = computed(() => engine.value?.editor);
    const pages = computed(() => sortedPages(editor.value));
    const pageNames = computed(() => pageNamesOf(editor.value));
    const pageFor = computed(() => pageResolver(editor.value));
    const moduleIds = () => Object.keys(engine.value?.modules ?? {});

    const queryPage = () => (typeof route.query.page === 'string' ? route.query.page : null);
    const requested = ref(queryPage() ?? readStoredPage(engineId()));
    // A pasted or edited link on the open editor.
    watch(queryPage, (id) => {
        if (id) requested.value = id;
    });

    const currentPage = computed(() => {
        const id = requested.value;
        return pages.value.some((p) => p.id === id) ? id! : pages.value[0].id;
    });

    const tabs = computed<PageTab[]>(() => {
        const counts = new Map<string, number>();
        for (const id of moduleIds()) {
            const page = pageFor.value(id);
            counts.set(page, (counts.get(page) ?? 0) + 1);
        }
        return pages.value.map((p) => ({
            id: p.id,
            name: p.name,
            moduleCount: counts.get(p.id) ?? 0,
        }));
    });

    function pageOf(moduleId: string): string {
        return pageFor.value(moduleId);
    }

    function selectPage(id: string) {
        requested.value = id;
        storePage(engineId(), id);
        if (queryPage() !== id) void router.replace({ query: { ...route.query, page: id } });
    }

    // Nothing before the layout has loaded: the engine exists from the sidebar's
    // info first, with no modules, so materialising would pin none. The tree
    // always serves `editor`: it is set exactly once the graph snapshot is in.
    function write(ops: PatchOp[]) {
        if (ops.length > 0 && editor.value) patch.editor(engineId(), ops);
    }

    /** A new last page ("Page N"), which this viewer then shows. */
    function addPage() {
        if (!editor.value) return;
        const { id, ops } = addPageOps(editor.value, moduleIds());
        write(ops);
        selectPage(id);
    }

    function renamePage(id: string, name: string) {
        write(renamePageOps(editor.value, moduleIds(), id, name));
    }

    function movePage(id: string, delta: -1 | 1) {
        write(movePageOps(editor.value, moduleIds(), id, delta));
    }

    const modulesOn = (pageId: string) =>
        Object.values(engine.value?.modules ?? {}).filter(
            (m) => pageFor.value(m.instanceId) === pageId,
        );

    /**
     * Delete `id`, its modules going to `targetId` right of what is already
     * there (layout kept), which this viewer follows if it was on `id`.
     */
    function deletePage(id: string, targetId: string) {
        const ops = deletePageOps(editor.value, moduleIds(), id, targetId);
        if (ops.length === 0) return;
        const moving = modulesOn(id);
        const positions = placeOnPage(modulesOn(targetId), moving);
        // Read before the write, which removes the page at once (currentPage then falls back to the first).
        const shown = currentPage.value === id;
        // deletePageOps already reassigns them: only module and tag positions are added.
        write([
            ...ops,
            ...moveModulesOps([], targetId, positions),
            ...shiftRefPosOps(editor.value, moving, positions),
        ]);
        if (shown) selectPage(targetId);
    }

    /** Why `ids` can't move to `pageId` (NEW_PAGE: a new page), or null. */
    function moveRefusal(ids: readonly string[], pageId: string): string | null {
        const eng = engine.value;
        if (!eng) return null;
        // NEW_PAGE never matches a page id (`pg-…`), so it reads as a page nobody else is on.
        return pcmCrossing(eng.modules, eng.connections ?? [], editor.value, ids, pageId);
    }

    /**
     * Move modules to page `target` (or NEW_PAGE) in one write, refused with a
     * toast when a PipeWire wire would end up across pages. On an existing page
     * they keep their layout and land right of what is already there.
     */
    function moveModules(ids: readonly string[], target: string) {
        const eng = engine.value;
        if (!eng || ids.length === 0) return;
        const fresh = target === NEW_PAGE ? addPageOps(editor.value, moduleIds()) : null;
        const pageId = fresh?.id ?? target;
        const reason = moveRefusal(ids, pageId);
        if (reason) {
            toast.show(reason);
            return;
        }
        const moving = ids.map((id) => eng.modules[id]).filter((m) => !!m);
        const positions = fresh ? [] : placeOnPage(modulesOn(pageId), moving);
        write([
            ...(fresh?.ops ?? []),
            ...moveModulesOps(ids, pageId, positions),
            ...shiftRefPosOps(editor.value, moving, positions),
        ]);
    }

    /**
     * Editor ops that put new modules (added, cloned) on the current page.
     * None while the layout has no pages: everything is on the implicit Page 1.
     */
    function newModuleOps(ids: readonly string[]): PatchOp[] {
        return hasPages(editor.value) ? moveModulesOps(ids, currentPage.value) : [];
    }

    /** A module made outside the canvas menus (the settings panel's Clone) joins the current page if it has none. */
    function adoptModule(id: string) {
        if (!Object.hasOwn(editor.value?.modulePages ?? {}, id)) write(newModuleOps([id]));
    }

    return {
        pages,
        tabs,
        pageNames,
        currentPage,
        pageOf,
        selectPage,
        addPage,
        renamePage,
        movePage,
        deletePage,
        moveRefusal,
        moveModules,
        newModuleOps,
        adoptModule,
    };
}

export type Pages = ReturnType<typeof usePages>;
