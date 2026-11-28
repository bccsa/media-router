import {
    EDITOR_MAX_BYTES,
    EDITOR_PATH,
    EditorLayoutSchema,
    EditorPageSchema,
    EditorPosSchema,
    applyJsonPatch,
    createLogger,
    dropUndefined,
    emptyEditorLayout,
    isEditorPath,
    isPlainObject,
    parseRefKey,
    parseStoredEditorLayout,
    type EditorLayout,
    type LiveArrayIndex,
    type PatchOp,
} from '@media-router/shared-types';
import type { RuleResult } from './patchRules.js';
import type { Processed } from './PatchRouter.js';
import { cleanupFor, dropOrphans, idsOf, type Keyed } from './editorCleanup.js';
import { editorOpError } from './tree/editorWrites.js';

const log = createLogger('EditorBatch');

const LAYOUT_KEYS = ['pages', 'modulePages', 'refs', 'tagged', 'nextRef'];

type Rewritten = RuleResult & { reason?: string };
type Schema = { safeParse(value: unknown): { success: boolean; data?: unknown } };

/** `op` with its value as `schema` keeps it (unknown keys dropped); an invalid one as sent, for finish() to refuse. */
function cleaned(op: PatchOp, schema: Schema): Rewritten {
    const parsed = schema.safeParse(op.value);
    return { processed: [parsed.success ? { ...op, value: parsed.data } : op], cascades: [] };
}

/**
 * The manager's half of keeping the routing editor's layout whole (ADR-0030),
 * for one `PatchRouter.preprocessOps` call: a working copy of the profile's
 * `editor` that follows every emitted op. Not a Rule — rules are pure and run
 * twice per op outside production.
 * - `onSenderOp`: refuses shapes outside the write whitelist (tree/editorWrites.ts)
 *   from any sender, numbers new refs, seeds a missing layout, swallows no-op
 *   adds and removes and writes about modules or connections that are gone,
 *   and stores values as the schema keeps them.
 * - `onEmitted`: every emitted op, before the arrays move on; returns the cleanup
 *   a module, connection or port removal needs (editorCleanup.ts).
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
    /** Module ids as of the ops emitted so far. */
    private readonly modules: Set<string>;

    /** `config` is the stored profile, as it was before this batch. */
    constructor(private readonly config: Record<string, unknown>) {
        this.modules = new Set(isPlainObject(config.modules) ? Object.keys(config.modules) : []);
    }

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

    /** `connections` as of this op, like the rules see them. */
    onSenderOp(
        op: PatchOp,
        index: number,
        connections: LiveArrayIndex<Keyed>,
    ): RuleResult | 'swallowed' {
        const refused = editorOpError(op, op.path.split('/').slice(2));
        const own: Rewritten | 'swallowed' = refused
            ? { processed: [], cascades: [], reason: refused }
            : this.rewrite(op, connections);
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
        const moduleId = /^\/modules\/([^/]+)$/.exec(op.path)?.[1];
        if (moduleId !== undefined) {
            if (op.op === 'remove') this.modules.delete(moduleId);
            else this.modules.add(moduleId);
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

    private rewrite(op: PatchOp, connections: LiveArrayIndex<Keyed>): Rewritten | 'swallowed' {
        const pass: Rewritten = { processed: [op], cascades: [] };
        const [record, key, field] = op.path.split('/').slice(2);
        const hasConnection = (id: string) => idsOf(connections.snapshot()).includes(id);
        if (record === undefined) {
            if (op.op === 'remove') return pass;
            // A whole layout (a rollback): what of it is valid and fits the graph, never lowering nextRef.
            const value = dropOrphans(
                parseStoredEditorLayout(op.value).layout,
                (id) => this.modules.has(id),
                hasConnection,
            );
            value.nextRef = Math.max(value.nextRef, this.working.nextRef);
            return { processed: [{ ...op, value }], cascades: [] };
        }
        const entries = (this.working as unknown as Record<string, unknown>)[record];
        if (key === undefined || !isPlainObject(entries)) return pass;
        // About a module or connection deleted meanwhile (another browser): the writer snaps back.
        if (op.op !== 'remove' && !this.fitsGraph(record, key, hasConnection)) return 'swallowed';
        const entry = Object.hasOwn(entries, key) ? entries[key] : undefined;
        if (field === undefined) {
            if (op.op === 'remove') return entry === undefined ? 'swallowed' : pass;
            // A module's page is a value, not a created record: an add sets it.
            if (op.op === 'add' && entry !== undefined && record !== 'modulePages')
                return 'swallowed';
            if (record === 'refs' && entry === undefined) return this.numbered(key, op.value);
            return record === 'pages' ? cleaned(op, EditorPageSchema) : pass;
        }
        if (entry === undefined) {
            if (op.op === 'remove') return 'swallowed';
            if (record === 'refs') return this.numbered(key, { [field]: op.value });
            return { processed: [], cascades: [], reason: 'That page no longer exists' };
        }
        if (op.op === 'remove' && !(isPlainObject(entry) && field in entry)) return 'swallowed';
        return field === 'pos' ? cleaned(op, EditorPosSchema) : pass;
    }

    /** False for a page or tag write about a module or connection that does not exist. */
    private fitsGraph(
        record: string,
        key: string,
        hasConnection: (id: string) => boolean,
    ): boolean {
        if (record === 'modulePages') return this.modules.has(key);
        if (record === 'tagged') return hasConnection(key);
        if (record !== 'refs') return true;
        const moduleId = parseRefKey(key)?.moduleId;
        return moduleId !== undefined && this.modules.has(moduleId);
    }

    /** A new ref gets the next number, whatever the sender sent; the bump is a cascade. */
    private numbered(key: string, fields: unknown): RuleResult {
        const { name, pos } = isPlainObject(fields) ? fields : {};
        const place = EditorPosSchema.safeParse(pos);
        const n = this.working.nextRef;
        const add: PatchOp = {
            op: 'add',
            path: `${EDITOR_PATH}/refs/${key}`,
            value: dropUndefined({ n, name, pos: place.success ? place.data : pos }),
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
            // The stored bytes, not the schema's output (which drops unknown keys).
            if (JSON.stringify(this.working).length > EDITOR_MAX_BYTES)
                return 'The page layout is too large';
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
