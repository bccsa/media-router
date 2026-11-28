import {
    EDITOR_PATH,
    EditorLayoutSchema,
    applyJsonPatch,
    createLogger,
    dropUndefined,
    emptyEditorLayout,
    isEditorPath,
    isPlainObject,
    parseStoredEditorLayout,
    type EditorLayout,
    type LiveArrayIndex,
    type PatchOp,
} from '@media-router/shared-types';
import type { RuleResult } from './patchRules.js';
import type { Processed } from './PatchRouter.js';
import { cleanupFor, type Keyed } from './editorCleanup.js';

// The manager's half of keeping the routing editor's layout (`editor`,
// ADR-0030) whole: ref numbers, seeding, cleanup after removals
// (editorCleanup.ts), validation. Which editor writes a browser may send:
// tree/editorWrites.ts.

const log = createLogger('EditorBatch');

const LAYOUT_KEYS = ['pages', 'modulePages', 'refs', 'tagged', 'nextRef'];

type Rewritten = RuleResult & { reason?: string };

/** What a rollback restores: the version's layout (defaults without one); numbers are never handed out twice. */
export function restoredEditor(current: unknown, version: unknown): EditorLayout {
    const layout = parseStoredEditorLayout(version).layout;
    layout.nextRef = Math.max(layout.nextRef, parseStoredEditorLayout(current).layout.nextRef);
    return layout;
}

/**
 * The editor half of one `PatchRouter.preprocessOps` call: a working copy of the
 * profile's `editor` that follows every emitted op. Not a Rule — rules are pure
 * and run twice per op outside production.
 * - `onSenderOp`: numbers new refs, seeds a missing layout, swallows no-op adds and removes.
 * - `onEmitted`: every emitted op, before the arrays move on; returns the cleanup
 *   a module, connection or port removal needs.
 * - `finish`: validates; a failing batch loses its sender editor ops and their
 *   nextRef bumps and keeps the cleanup.
 */
export class EditorBatch {
    private layout?: EditorLayout;
    /** What a leaf op needs first: `add /editor` (none stored) or `replace /editor` (stored one broken). */
    private base: 'seed' | 'heal' | null = null;
    private storedDropped: string[] = [];
    /** Emitted sender editor ops and their nextRef bumps, by identity. */
    private readonly senderOps = new Set<PatchOp>();
    private readonly senderIndexes: number[] = [];
    private readonly reasons: Record<number, string> = {};

    /** `config` is the stored profile, as it was before this batch. */
    constructor(private readonly config: Record<string, unknown>) {}

    /** Parsed on first use: most batches (a fader drag) never touch the layout. */
    private get working(): EditorLayout {
        if (!this.layout) {
            const raw = this.config.editor;
            const { layout, dropped } = parseStoredEditorLayout(raw);
            this.layout = layout;
            this.storedDropped = dropped;
            const broken =
                !isPlainObject(raw) || dropped.length > 0 || LAYOUT_KEYS.some((k) => !(k in raw));
            this.base = raw === undefined ? 'seed' : broken ? 'heal' : null;
        }
        return this.layout;
    }

    private set working(layout: EditorLayout) {
        this.layout = layout;
    }

    onSenderOp(op: PatchOp, index: number): RuleResult | 'swallowed' {
        const own = this.rewrite(op);
        if (own === 'swallowed') return own;
        if (own.processed.length === 0) {
            if (own.reason) this.reasons[index] = own.reason;
            return own;
        }
        const lead = op.path === EDITOR_PATH ? [] : this.lead();
        own.processed.forEach((p) => this.senderOps.add(p));
        this.senderIndexes.push(index);
        return { processed: [...lead, ...own.processed], cascades: [...lead, ...own.cascades] };
    }

    onEmitted(op: PatchOp, connections: LiveArrayIndex<Keyed>): PatchOp[] {
        if (isEditorPath(op.path)) {
            this.apply(op);
            return [];
        }
        const cleanup = cleanupFor(op, () => this.working, connections);
        cleanup.forEach((c) => this.apply(c));
        return cleanup;
    }

    finish(out: Processed): void {
        Object.assign(out.reasons, this.reasons);
        if (this.senderIndexes.length === 0) return;
        const reason = this.invalidReason();
        if (reason === null) return;
        log.warn(
            { reason, indexes: this.senderIndexes },
            'Editor writes refused: the page layout would be invalid',
        );
        const kept = (op: PatchOp) => !this.senderOps.has(op);
        out.processed = out.processed.filter(kept);
        out.cascades = out.cascades.filter(kept);
        // idPath leaves /editor ops as they are, so the published entries hold the same objects.
        out.published = out.published.filter((entry) => kept(entry.op));
        for (const index of this.senderIndexes) {
            out.dropped.push(index);
            out.reasons[index] = reason;
        }
    }

    private rewrite(op: PatchOp): Rewritten | 'swallowed' {
        const pass: Rewritten = { processed: [op], cascades: [] };
        const [record, key, field] = op.path.split('/').slice(2);
        if (record === undefined) {
            if (op.op === 'remove') return pass;
            // A whole layout (a rollback): what of it is valid, never lowering nextRef.
            const value = parseStoredEditorLayout(op.value).layout;
            value.nextRef = Math.max(value.nextRef, this.working.nextRef);
            return { processed: [{ ...op, value }], cascades: [] };
        }
        const entries = (this.working as unknown as Record<string, unknown>)[record];
        if (key === undefined || !isPlainObject(entries)) return pass;
        const entry = Object.hasOwn(entries, key) ? entries[key] : undefined;
        if (field === undefined) {
            if (op.op === 'remove') return entry === undefined ? 'swallowed' : pass;
            // A module's page is a value, not a created record: an add sets it.
            if (op.op === 'add' && entry !== undefined && record !== 'modulePages')
                return 'swallowed';
            return record === 'refs' && entry === undefined ? this.numbered(key, op.value) : pass;
        }
        if (entry === undefined) {
            if (op.op === 'remove') return 'swallowed';
            if (record === 'refs') return this.numbered(key, { [field]: op.value });
            return { processed: [], cascades: [], reason: 'That page no longer exists' };
        }
        if (op.op === 'remove' && !(isPlainObject(entry) && field in entry)) return 'swallowed';
        return pass;
    }

    /** A new ref gets the next number, whatever the sender sent; the bump is a cascade. */
    private numbered(key: string, fields: unknown): RuleResult {
        const { name, pos } = isPlainObject(fields) ? fields : {};
        const n = this.working.nextRef;
        const add: PatchOp = {
            op: 'add',
            path: `${EDITOR_PATH}/refs/${key}`,
            value: dropUndefined({ n, name, pos }),
        };
        const bump: PatchOp = { op: 'replace', path: `${EDITOR_PATH}/nextRef`, value: n + 1 };
        return { processed: [add, bump], cascades: [bump] };
    }

    /** Seed or heal once, before the batch's first leaf op, so no op lands on a missing or broken parent. */
    private lead(): PatchOp[] {
        const base = this.base;
        this.base = null;
        if (base === 'seed') return [{ op: 'add', path: EDITOR_PATH, value: emptyEditorLayout() }];
        if (base === 'heal') {
            log.warn(
                { dropped: this.storedDropped },
                'Stored page layout was incomplete or had invalid entries: rewriting it',
            );
            return [{ op: 'replace', path: EDITOR_PATH, value: structuredClone(this.working) }];
        }
        return [];
    }

    private apply(op: PatchOp): void {
        if (op.path === EDITOR_PATH) {
            this.working =
                op.op === 'remove' ? emptyEditorLayout() : parseStoredEditorLayout(op.value).layout;
            this.base = op.op === 'remove' ? 'seed' : null;
            return;
        }
        const rel = {
            ...op,
            path: op.path.slice(EDITOR_PATH.length),
            value: structuredClone(op.value),
        };
        applyJsonPatch(this.working as unknown as Record<string, unknown>, [rel]);
    }

    private invalidReason(): string | null {
        try {
            const result = EditorLayoutSchema.safeParse(this.working);
            return result.success
                ? null
                : (result.error.issues[0]?.message ?? 'invalid page layout');
        } catch (err) {
            log.error({ err }, 'Page layout check failed');
            return 'invalid page layout';
        }
    }
}
