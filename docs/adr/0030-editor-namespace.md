# ADR-0030: The routing editor's layout is one `editor` key in the profile, kept by the manager

The routing editor's pages and cross-reference tags (issue #871) are stored
as a top-level `editor` key in the profile JSON
(`shared-types/src/editorLayout.ts`): `pages` (keyed by an internal
`pg-<random>` id, each with a shown `name` and a tab `order`), `modulePages`
(module → page), `refs` (`out|in:<module>:<port>` → a tag's number, name and
dragged position), `tagged` (same-page connections drawn as tags) and
`nextRef`. Tags themselves are derived from the connections in the UI; only
what a user set, and the number, is stored. Decided with the user on
2026-11-26.

- **Stored and sent like positions.** The key is saved, pushed to routers and
  patched to them like any config op, with no strip code. Routers store it and
  ignore it: no side effect, plugin or LCP reads it, and a connect push copies
  non-graph keys as they are. Export, import, profile copy and history need
  nothing new.
- **The manager keeps it whole.** Browser writes are limited to a whitelist
  of op shapes (`tree/editorWrites.ts`). `EditorBatch` (`editorRules.ts`) runs
  inside each PatchRouter batch: it hands out ref numbers (`n = nextRef++`,
  never reused, also across rollbacks), seeds a missing layout, swallows an add
  of an existing key or a remove of a missing one (the writer alone gets the
  current value back), drops a module's page and refs, a connection's `tagged`
  entry and a vanished port's refs whatever removed them (`editorCleanup.ts`,
  also for the router's dynamic ports), and refuses a batch whose result fails
  `EditorLayoutSchema` (unique page names ignoring case, unique ref numbers, a
  size cap).
- **Never reset on read.** A stored value is read with
  `parseStoredEditorLayout`: unknown keys stripped, each invalid entry dropped
  on its own and logged, so version skew can't wipe a layout.

## Why

The layout belongs to the profile it draws (copied, exported and rolled back
with it), and positions already travel this way, so routers needed no change.
The manager is the one place every browser's writes meet, so numbering and
cleanup there can't race between browsers, and it sees module, connection and
port removals from every source, the router's own included.
