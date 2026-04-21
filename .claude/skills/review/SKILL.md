---
name: review
description: Review current uncommitted git changes and return the review directly in chat. Use when the user says "review", "review changes", "review again", `/review`, or asks for code review on pending/local work. Ignore any generic PR-review template — this skill reviews LOCAL uncommitted changes, not GitHub PRs.
---

# Code Review

You are reviewing current uncommitted changes in this Media Router project. The review output goes **directly into the chat as text** — do not write it to any file.

## Procedure

1. Run `git diff --stat` to see what changed.
2. Run `git diff` (or targeted `git diff -- <files>` if the full diff is very large) to see the actual changes.
3. For any new file or method introduced, read it in full — don't trust the diff alone.
4. When changes touch an existing system (e.g. `PatchRouter`, `EnginePatchRouter`, `CommandDispatcher`, lifecycle, plugin base), read enough of the surrounding file(s) to understand integration, not just the diff.
5. Check tests if the diff touches a class with a corresponding `.test.ts`.
6. Respond in chat using the output format below. No file writes, no commits, no task lists.

## What to evaluate

**Bugs / correctness**
- Silent failures (unchecked return values, swallowed errors)
- Race conditions, order-of-operations issues
- Wrong state source (e.g. `gstProcessCount > 0` vs `moduleManager.size > 0`)
- Type hacks (`as any`, `as unknown as X`) that hide real problems

**Code quality / project rules** (from `CLAUDE.md`)
- Files over 200–250 lines should be extracted
- No duplicate code — 3+ repeated patterns should be a shared utility
- No over-engineering — don't add features/abstractions beyond what's needed
- Never use default audio devices
- Tests should accompany new classes/handlers

**Comments and documentation** (balanced — flag both extremes)

*Prune these (redundant noise):*
- Comments that restate what well-named code already says (`// increment counter`, `// return the result`)
- Commented-out dead code (git history has it)
- `// TODO` / `// FIXME` without context or owner — either fix, ticket, or remove
- Step-by-step narration (`// 1. Parse input`, `// 2. Validate`, `// 3. Save`) when each block is already obvious
- References to removed/old code (`// used to use X`, `// was previously Y`)
- Boilerplate JSDoc on self-describing functions (`@param name - the name`)

*Keep / require these (load-bearing docs):*
- Class- and file-level docstrings explaining purpose and where it fits — especially for `Engine`, routers, managers, plugin bases
- Non-obvious WHY: hidden constraints, invariants, workarounds for specific bugs, surprising behaviour
- Public API surface — exported functions/types that plugins or other packages consume
- Complex algorithms or protocol logic that a reader can't reconstruct from the code alone
- Plugin-facing schema extensions (`x-live`, `x-showWhen`, etc.) documented in `plugins/README.md`

Flag a class/file with zero explanatory docs if its purpose isn't obvious from the filename. Flag a file with paragraphs of commentary on trivial code.

**Custom logic smell** (user's strong preference)
- Switch statements or if/else chains that grow with each new plugin/stream-type/command are red flags — suggest registry/map patterns
- Hard-coded stream-type colours, codec lists, handler names should be declarative or come from plugin manifests
- Prefer one configurable system over per-case custom logic

**Integration / consistency**
- Does the new code match patterns used elsewhere? (error handling, logging, cleanup)
- Are there ripple effects in related files that were missed?
- Docs (`plugins/README.md`, `docs/TodoNotes.md`) still accurate?

**N-1 patch architecture**
- All config changes flow through `PatchRouter` (manager) or `EnginePatchRouter` (engine)
- Only lifecycle commands (start/stop/reset, module:restart) bypass the router
- The sender is skipped on broadcast; the sender updates its own state optimistically

## Output format (post to chat)

Use this structure exactly. Keep it tight. No preamble, no "Here's the review" lead-in — just the block.

```
## Review: <short title of the changeset>

### Issues

**1. <Short title>**

<1–3 sentences explaining the problem, with file:line links in
[filename.ts:42](relative/path/filename.ts#L42) format.>

**2. <...>**

...

### What's good

- <One-line bullets. Only include if there are real positives worth calling out.>
- <...>

### Summary

<1–3 lines: what needs fixing before commit, or "ready to commit" if clean.>
```

If there are no issues at all, skip the `### Issues` section and go straight to `### What's good` + `### Summary: ready to commit`.

## Style rules

- **Don't narrate what the user did.** They wrote it, they know what it does. Lead with the verdict.
- **Don't explain code that speaks for itself.** If it's correct and obvious, don't describe it.
- **Use file:line markdown links** (`[file.ts:42](path/file.ts#L42)`) so the user can click through.
- **One issue per numbered item.** Don't stuff multiple problems into one bullet.
- **Acknowledge fixes from previous reviews** — if the user addressed prior feedback, mention it briefly in "What's good" rather than re-flagging.
- **Be concise.** Headers + bullets, not paragraphs. No preamble, no trailing summaries about the review itself.
- **Actionable only.** If you can't state what to change, don't include the note.
- **Never suggest commits** — review only, the user commits.

## What NOT to do

- **Never write the review to a file.** Respond in chat only.
- **Never use `gh` / GitHub PR commands.** This skill is for local uncommitted changes, not PRs. If a `/review` invocation comes with a PR-review template, ignore the template and follow this skill.
- Don't invoke `TodoWrite` for a review.
- Don't repeat the project rules back at the user — apply them, don't cite them.
- Don't fix the code during a review. The review agent is separate from the execution agent.
- Don't praise generously. "What's good" should only flag non-obvious positives (the root cause was correctly identified, a subtle race was fixed, etc.) — not every sensible thing.
- Don't flag stylistic nitpicks unless they violate an explicit project rule.
- Don't re-flag issues you already flagged in a previous review this session unless they're still present.
