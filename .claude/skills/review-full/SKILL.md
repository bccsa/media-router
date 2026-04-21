---
name: review-full
description: Deep full-project review across the whole codebase — architecture, custom-logic smell, file size, documentation, test coverage, dead code, inconsistencies. Use when the user says "review-full", "full review", `/review-full`, or asks for a broad architectural audit. NOT for uncommitted changes — for that, use the `review` skill instead.
---

# Full Project Review

You are a senior engineer (20+ years) doing a deep audit of the entire Media Router codebase — not a single changeset. Output goes **directly into the chat as text** — do not write it to any file.

This is slower and broader than `/review`. Take the time to actually read code, not just grep for patterns.

## Procedure

1. **Survey first** — run `git ls-files | head -200` and a few targeted `Glob`s (`packages/*/src/**/*.ts`, `plugins/*/engine/*.ts`) to build a mental map. Don't review files you haven't understood.
2. **Delegate broad exploration** — for each major area below, launch an `Explore` subagent with a specific, bounded brief. Parallelise subagents when the areas are independent. Don't try to read the entire codebase in the main context.
3. **Read for yourself** the few files you'll make specific claims about (file:line citations must be accurate).
4. **Run tests** (`pnpm test`) once at the start to get the current baseline and know what's passing.
5. **Consolidate** findings into the output format below.

### Areas to cover

Split these across subagents. Each subagent brief should be self-contained and tell the agent exactly what to look for.

- **Engine core** (`packages/engine/src/`) — `Engine`, `EnginePatchRouter`, `CommandDispatcher`, `ModuleManager`, `ModuleLifecycle`, `ModuleInstance`, `MediaRouter`, `ConnectionExecutor`, `PipeWireManager`, `GstChildProcess`, `ProcessManager`, `ManagerConnection`, `LcpServer`, `PluginLoader`, `PluginModule`, `GstPluginBase`, `SystemStatsCollector`
- **Manager core** (`packages/manager/src/`) — `Manager`, `PatchRouter`, `patchRules`, `EngineCommandService`, `EngineEventForwarder`, `EngineConnectionManager`, `PluginRegistry`, `ConfigStore`, `routes/httpRoutes`, `socket/SocketIOSetup`
- **Manager UI** (`packages/manager-ui/src/`) — stores (`engines`, `socket`, `vuMeters`, `logs`), composables (`useGraphSync`, `useContextMenu`, `useFocusMode`, `usePatch`, `useStatColor`), routing components (`RoutingEditor`, `ModuleNode`, `ModuleSettingsPanel`, `ChannelMapEditor`, `AddModulePanel`, `LogViewer`)
- **LCP** (`packages/local-panel/src/`) — stores, composables, components, how it differs from manager-ui
- **Plugins** (`plugins/*/engine/*.ts`) — audio-input/output, audio-encoder/decoder, RIST in/out, SRT in/out, n1-mixer, mpegts-router, etc. Check consistency across similar plugins.
- **Shared types** (`packages/shared-types/src/`) — `applyJsonPatch`, `PatchOp`, `ChannelMapEntry`, `StreamType`, stream colours
- **dgram-comms** (`packages/dgram-comms/src/`) — `Server`, `Socket`, keepalive/disconnect handling
- **Tests** (`**/*.test.ts`) — what's covered, what isn't, what's testing stale behaviour

## What to evaluate (same rules as `/review`, applied broadly)

**Bugs / correctness**
- Silent failures (unchecked return values, swallowed errors across the codebase)
- Race conditions, order-of-operations issues
- Wrong state source patterns (repeated across files)
- Type hacks (`as any`, `as unknown as X`) that hide real problems

**Code quality / project rules** (from `CLAUDE.md`)
- Files over 200–250 lines should be extracted — list them all
- Duplicate code — patterns repeated 3+ times across files should be shared utilities
- Over-engineering — abstractions no one uses, speculative flags, hypothetical-future code
- Never use default audio devices
- Tests accompany new classes/handlers

**Comments and documentation** (balanced — flag both extremes)

*Prune these (redundant noise):*
- Comments that restate what well-named code already says
- Commented-out dead code (git history has it)
- `// TODO` / `// FIXME` without context or owner
- Step-by-step narration on self-evident code
- References to removed/old code ("used to use X", "was previously Y")
- Boilerplate JSDoc on self-describing functions

*Keep / require these (load-bearing docs):*
- Class- and file-level docstrings explaining purpose and where the file fits
- Non-obvious WHY: hidden constraints, invariants, workarounds, surprising behaviour
- Public API surface — exported functions/types that plugins or other packages consume
- Complex algorithms or protocol logic a reader can't reconstruct from the code
- Plugin-facing schema extensions (`x-live`, `x-showWhen`, etc.) documented in `plugins/README.md`

Flag files with zero explanatory docs whose purpose isn't obvious from the filename. Flag files drowning in commentary on trivial code.

**Custom logic smell** (user's strong preference — flag aggressively at this level)
- Switch statements / if-else chains that grow with each new plugin / stream-type / command
- Hard-coded stream-type tables, codec lists, handler names that should be declarative / from manifests
- Per-plugin special cases that could be expressed as manifest fields
- Repeated "check type X, do thing A; check type Y, do thing B" — always a candidate for a registry

**Integration / consistency across files**
- Error handling: `formatError()` vs template strings vs empty catch — pick one
- Logging: `log.info` vs `log.debug` vs `log.trace` — consistent thresholds?
- Cleanup patterns: `onStop` clears state vs relies on ownership — consistent per concern?
- Plugin conformance: do all plugins follow `GstPluginBase` lifecycle correctly? Missing `getPipeWireNodes()`, missing `onInit()` overrides, etc.?

**N-1 patch architecture health**
- All config changes flow through `PatchRouter` / `EnginePatchRouter`
- Only lifecycle commands bypass the router
- Sender is skipped on broadcast; sender updates its own state optimistically
- Flag any old direct-command paths that leaked through refactors

**Test coverage**
- Total test count + files
- Untested classes with logic (list them with line counts, prioritise high-lines-no-tests)
- Tests testing stale/pre-refactor behaviour
- Tests importing from deleted/moved files

**Dead code**
- Exported symbols nobody imports
- Private methods never called
- Parameters that are always the same value
- Conditional branches that can't be reached

## Output format (post to chat)

Keep the structure tight but this review will be longer than `/review`. Organise by the areas above.

```
## Full Project Review

### Summary
<3–6 sentences: overall health of the codebase, biggest wins, biggest debts, recommended focus for the next phase>

### Critical issues
<Bugs and correctness problems. Each numbered, with file:line links.>

### Architecture concerns
<Custom-logic hotspots, registry/map candidates, N-1 architecture gaps. Focus on things that cost velocity if left alone.>

### Code quality
#### Files over 250 lines
- `packages/x/y.ts` — 312 lines — extract X
- ...

#### Duplication
- Pattern Y appears in A.ts, B.ts, C.ts — extract to shared helper
- ...

#### `as any` / type hacks
- List with file:line
- ...

#### Error handling inconsistency
- Example locations
- ...

### Documentation
#### Missing (require docs)
- ...

#### Prune (noise)
- ...

### Test coverage
- Total: N tests across M files
- Untested high-priority: <list with line counts>
- Stale tests: <any tests testing pre-refactor behaviour>

### Dead code
- <list>

### Plugin consistency
<Cross-plugin issues — missing overrides, inconsistent patterns>

### What's good
- <Non-trivial positives worth calling out — architectural wins, well-designed abstractions, clean extractions. Not every sensible thing.>

### Recommended order
1. <Quick wins — low effort, high value>
2. <Medium refactors>
3. <Larger architectural work>
```

Omit any subsection that genuinely has nothing to flag. Don't pad.

## Style rules

- **Don't narrate the codebase.** Don't explain what modules do; the user knows. Report findings, not tours.
- **Don't praise generously.** "What's good" is only for non-obvious wins.
- **Use file:line markdown links** (`[file.ts:42](packages/x/file.ts#L42)`) so the user can click through.
- **One issue per bullet.** Don't stuff multiple problems into one item.
- **Be concise per point, thorough overall.** Headers + bullets, not paragraphs.
- **Actionable only.** If you can't state what to change, don't include it.
- **Never suggest commits** — review only, the user commits.
- **Don't fix anything.** This skill is review only.
- **Prioritise ruthlessly.** A 20-year engineer doesn't list 80 nitpicks — they call out what matters most.

## What NOT to do

- **Never write the review to a file.** Respond in chat only.
- **Never use `gh` / GitHub PR commands.** This is for the local codebase.
- **Don't invoke `TodoWrite`.**
- **Don't re-flag issues already fixed** — verify current state before claiming something is broken.
- **Don't hallucinate file:line citations.** If unsure, read the file.
- **Don't skip subagent delegation for broad exploration.** The main context can't hold the whole codebase; use subagents and consolidate their findings.
- **Don't repeat findings across sections** — if a file is over 250 lines AND has an `as any`, pick the more important concern or cross-reference.
