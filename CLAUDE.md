# CLAUDE.md — Working Instructions for Media Router

## About the Project

Media Router is a distributed broadcast media routing system for BCC South Africa. It routes audio (and eventually video) between devices using GStreamer pipelines and PipeWire. The architecture is Manager + Engine with a Vue 3 web UI.

- **Stack**: TypeScript, pnpm monorepo, Vue 3, Pinia, Vue Flow, Express v5, Fastify, Socket.IO, SQLite, GStreamer, PipeWire, Python GI bindings
- **Target hardware**: Raspberry Pi 5 (arm64), Debian 12 Bookworm
- **Docs**: `docs/URS-v2.0.md`, `docs/FDS-v2.0.md`, `docs/implementation-plan-v2.0.md`
- **Active issues**: `docs/TodoNotes.md`
- **Plugin guide**: `plugins/README.md`

## How I Work

### Code Quality

- **No big files.** If a file exceeds ~200-250 lines, extract it. Manager.ts went from 1071 → 105 lines. Engine.ts from 668 → 230. MediaRouter from 518 → 225. Keep extracting until each file has a single clear responsibility.
- **No duplicate code.** If you see the same pattern 3+ times, extract a component/utility/composable. Example: 7 tooltip wrappers → `MrTooltip.vue`. Raw form elements in settings → shared `MrSlider`, `MrSelect`, `MrInput`, `MrToggle`.
- **No over-engineering.** Don't add features, abstractions, or error handling beyond what's needed. Three similar lines is better than a premature abstraction. Keep it simple.
- **Reuse existing code.** Before writing something new, check if there's an existing utility, composable, or component that does it. Search the codebase first.

### Audio Routing

- **NEVER use default audio devices.** No `@DEFAULT_AUDIO_SINK@`, no implicit fallback. All audio routing must target an explicitly configured device. If no device is configured, fail with a clear error — never silently play to an unexpected device. This is a broadcast system.

### Testing

- **Run `pnpm test` after every change.** No exceptions. If tests break, fix them immediately as part of the same change.
- **Write tests for new features.** Any new class, handler, utility, or significant logic needs a `.test.ts` file alongside it. Include the test count in the commit message.
- **Current baseline**: 200 tests across 20 files. Never go below this.
- **Test command**: `pnpm test` from project root. Coverage: `pnpm test -- --coverage`.

### Git & Commits

- **NEVER commit without my approval.** Always:
  1. Show `git status` + summary of changes
  2. Draft the commit message
  3. Wait for me to say "commit" or "yes"
- **Conventional commit format**:
  - Prefix: `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `test:`
  - Short title under 70 chars
  - Body with bullet points for each change
  - Test count at the end: "200 tests passing across 20 files."
  - Co-author: `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>`
  - Use HEREDOC format: `git commit -m "$(cat <<'EOF' ... EOF)"`
- **Never force push, amend, or use destructive git operations** unless I explicitly ask.

### Code Reviews

When I paste a review or ask you to review changes:
1. Check the diff itself — clean code, bugs, maintainability
2. Check wider integration — does it fit with the rest of the codebase?
3. Check file placement — is logic in the right file/module?
4. Check for ripple effects — other files that should have been updated but weren't
5. Check if tests were added for the new functionality

### UI / Frontend

- **Dark theme first** — `--bg-primary: #0f1117`, `--bg-card: #232735`, `--accent: #10b981` (emerald)
- **Mobile responsive** — sidebar collapses, toolbar wraps, safe area padding for iOS
- **Vue Flow** for the routing editor — modules as nodes, connections as edges
- **Shared components**: `MrButton`, `MrInput`, `MrSelect`, `MrSlider`, `MrToggle`, `MrTooltip`, `MrModal`, `MrContextMenu` — use these instead of raw HTML elements
- **Composables** for complex logic: `useContextMenu`, `useFocusMode`, `useGraphSync`
- **Tooltips** use the styled popup pattern (`group/tb` + `group-hover/tb:block`), not native `title` attributes

### Plugin Architecture

- Plugins live in `plugins/<name>/` with a `package.json` manifest (`mediaRouter` field)
- Engine modules extend `GstPluginBase` and implement `buildPipeline(config)`
- Services available to plugins: `this.services.pipeWire`, `this.services.mediaRouter`, `this.services.processManager`
- Cleanup is automatic via ownership tracking — plugins don't need manual cleanup in `onStop()`
- Custom schema extensions: `x-widget`, `x-live`, `x-maxFrom`, `x-contextMenu`, `x-unit`, `x-deviceType`, `x-readOnly`

### Communication Style

- Be concise. Go straight to the point.
- Don't summarize what I said back to me.
- Don't add trailing summaries after completing work — I can read the diff.
- When I say "continue", just continue. Don't ask what to continue with.
- When something is broken, trace the actual error before proposing a fix. Don't guess.
- When I report a bug, investigate first — read the code, check the logs, understand the flow. Then fix.

### Process

- Use `TodoWrite` for multi-step tasks. Mark each task as completed as you finish it.
- Use `EnterPlanMode` for non-trivial new features — plan before implementing.
- Update `docs/TodoNotes.md` when completing items.
- When adding new infrastructure (services, base classes, utilities), update `plugins/README.md` so plugin developers know about it.
- When moving/renaming files, update all references including docs, comments, and launch.json.

### Running the Project

```bash
# Install
pnpm install

# Dev (3 terminals)
pnpm --filter @media-router/manager dev        # Manager backend (port 8080)
pnpm --filter @media-router/manager-ui dev     # Manager UI (port 5173, proxies to 8080)
pnpm --filter @media-router/engine dev         # Engine (API port 3001, dgram-comms port 3000)

# Build all
pnpm build

# Test
pnpm test

# Test with coverage
pnpm test -- --coverage
```

### Port Map

| Port | Service |
|------|---------|
| 3000 | dgram-comms (encrypted UDP) |
| 3001 | Engine Local API (Fastify) |
| 5173 | Manager UI dev (Vite) |
| 8080 | Manager HTTP + Socket.IO |
| 8081 | Local Control Panel |
| 8082 | Profile Manager |
