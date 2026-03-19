# Media Router v2.0 — Detailed Implementation Plan

| Field            | Value                              |
|------------------|------------------------------------|
| Document         | IMP-MR-2.0                         |
| Version          | 2.0                                |
| Date             | 2026-03-16                         |
| Organisation     | BCC South Africa                   |
| Related          | URS-MR-2.0, FDS-MR-2.0            |

---

## 1. Overview

This plan builds Media Router v2.0 from scratch in 15 sequential phases. Each phase produces a working, testable increment. The approach is bottom-up: infrastructure first, then media pipelines, then UI, then polish.

**Guiding principles:**

- Each phase ends with a **deployable milestone** testable on real hardware
- Dependencies flow forward — no phase requires work from a later phase
- Every phase has concrete **acceptance criteria** — don't move on until they pass
- P1 requirements complete in Phases 0–9; P2 in Phases 10–11; P3 in Phases 12–13
- v1.0 feature parity achieved at end of Phase 9
- **Build the simplest working version first**, then iterate

**Technology decisions (from FDS):**

| Concern | Choice |
|---------|--------|
| Language | TypeScript (strict mode) throughout |
| Monorepo | pnpm workspaces |
| Engine runtime | Node.js + Fastify (Local API) |
| Manager runtime | Node.js + Express v5 |
| Media pipelines | GStreamer via child processes |
| Audio routing | PipeWire native linking |
| Config storage | SQLite (better-sqlite3) |
| Engine↔Manager | dgram-comms (custom UDP, AES-256, multi-path) |
| Manager↔Browser | Socket.IO + JSON Patch (RFC 6902) |
| Engine↔LCP | Socket.IO on localhost |
| Manager UI | Vue 3 + Pinia + Vue Router + Vue Flow + Tailwind CSS v4 |
| Local Control Panel | Vue 3 + Tailwind CSS v4 (separate app) |
| Profile Manager | Vue 3 + Tailwind CSS v4 (separate app) |
| Testing | Vitest (unit/integration), Playwright (E2E) |
| Theme | Protocol-style dark theme, CSS custom properties |

---

## 2. Phase Summary

| Phase | Name | Focus | Est. Duration |
|-------|------|-------|---------------|
| 0 | Project Foundation | Monorepo, tooling, shared types, CI | 2 weeks |
| 1 | Communication Layer | dgram-comms v2 — encryption, fragmentation, multi-path UDP | 3 weeks |
| 2 | Engine Core | Engine process, plugin loader, module manager, Local API | 3 weeks |
| 3 | GStreamer Child Process Runtime | gst-runner child script, IPC protocol, pipeline execution | 2 weeks |
| 4 | Core Audio Plugins | AudioEncoder, AudioDecoder, PipeWire audio routing | 3 weeks |
| 5 | Manager Core | Manager process, ConfigStore, engine connection handling, Socket.IO | 3 weeks |
| 6 | Manager Web UI | Routing editor, engine dashboard, profiles, settings, component library | 4 weeks |
| 7 | Protocol Plugins — SRT & RIST | SrtInput, SrtOutput, RistInput, RistOutput | 2 weeks |
| 8 | Protocol Plugins — HLS & Stream Probing | HlsPlayer, fMP4 transmux, MPEG-TS probing | 2 weeks |
| 9 | Audio Processing Plugins | N-1 Mixer, Sound Processor, Sound Ducking | 2 weeks |
| 10 | Local Control Panel | Operator mixer with faders, VU meters, mute | 2 weeks |
| 11 | Profile Manager App | Engine-side manager connection config (port 8082) | 1 week |
| 12 | Video Modules & Advanced Features | VideoEncoder/Decoder/Player, focus mode, live-updatable config | 3 weeks |
| 13 | Security & Authentication | RBAC, bcrypt auth, per-engine permissions, input sanitisation | 2 weeks |
| 14 | Observability & Logging | Structured logging, Prometheus metrics, health checks | 2 weeks |
| 15 | Hardening & Deployment | 72h soak tests, Debian packages, Docker, docs | 3 weeks |

**Total estimated: 35 weeks**

---

## 3. Phase Details

---

### Phase 0 — Project Foundation

**Goal:** Monorepo skeleton with build tooling, CI, shared type definitions, and theme. Zero runtime functionality — just "pnpm build passes".

#### Tasks

| # | Task | Details | URS | FDS |
|---|------|---------|-----|-----|
| 0.1 | Initialise pnpm workspace monorepo | `v2/` root with `pnpm-workspace.yaml`, root `package.json` with workspace scripts (`dev`, `build`, `test`, `lint`) | UR-ENG-001 | §13 |
| 0.2 | Create package stubs | `packages/engine`, `packages/manager`, `packages/manager-ui`, `packages/local-panel`, `packages/profile-manager`, `packages/dgram-comms`, `packages/shared-types`. Each gets `package.json`, `tsconfig.json`, `src/index.ts` | — | §13.3 |
| 0.3 | TypeScript configuration | Shared `tsconfig.base.json` (strict, ES2022, NodeNext). Per-package `tsconfig.json` extends base with project references. `composite: true` for incremental builds | UR-ENG-001 | §2 |
| 0.4 | Vitest setup | Shared `vitest.config.ts` at root. Per-package test configs. One example test per package proving the setup works | UR-TST-001 | §12.1 |
| 0.5 | ESLint + Prettier | Shared configs. Rules: no `any` (warn), consistent imports, trailing commas. Format on save | — | — |
| 0.6 | CI pipeline | GitHub Actions: lint → type-check → test → build on every PR. Cache pnpm store. Fail fast | UR-TST-006 | §12.4 |
| 0.7 | Tailwind CSS v4 setup | Install `tailwindcss`, `@tailwindcss/vite` for `manager-ui`, `local-panel`, `profile-manager`. Verify PostCSS works in Vite dev server | UR-UI-001 | §5.1 |
| 0.8 | Protocol-style dark theme | Create `main.css` with CSS custom properties for dark mode (primary) and light mode. Define all colour tokens per FDS §5.5.1: bg, text, accent, ports, health, VU. Use `.dark` class toggle | UR-UI-006 | §5.5.1 |
| 0.9 | Plugin directory structure | `v2/plugins/` with `example-plugin/` containing `package.json` (with `mediaRouter` manifest), `engine/ExampleModule.ts`, `tsconfig.json`. Shared `tsconfig.plugin.json` base config | UR-PLG-001 | §9.1 |
| 0.10 | `shared-types` package | Define all shared TypeScript interfaces: `StreamType`, `ModulePort`, `ModuleRuntimeState`, `DgramMessage`, `ManagerConnectionProfile`, `MpegTsStreamInfo`, `AudioDeviceSettings`, `ControlIpcMessage`, `PluginManifest`. Include JSDoc on every type | — | §3.2, §9.2 |

#### Files to create

```
v2/
├── package.json                    # workspace root
├── pnpm-workspace.yaml             # workspace: packages/*, plugins/*
├── tsconfig.base.json              # shared TS config
├── vitest.config.ts                # shared test config
├── .eslintrc.cjs                   # lint config
├── .prettierrc                     # format config
├── .github/workflows/ci.yml        # CI pipeline
├── packages/
│   ├── shared-types/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/index.ts            # ALL shared type definitions
│   ├── dgram-comms/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/index.ts            # re-export stub
│   ├── engine/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/index.ts
│   ├── manager/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/index.ts
│   ├── manager-ui/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── vite.config.ts
│   │   ├── index.html
│   │   └── src/
│   │       ├── main.ts
│   │       ├── App.vue
│   │       └── assets/main.css     # theme CSS variables
│   ├── local-panel/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── vite.config.ts
│   │   └── src/...
│   └── profile-manager/
│       ├── package.json
│       ├── tsconfig.json
│       ├── vite.config.ts
│       └── src/...
└── plugins/
    ├── tsconfig.plugin.json         # shared plugin TS config
    └── example-plugin/
        ├── package.json             # with mediaRouter manifest
        ├── tsconfig.json
        └── engine/ExampleModule.ts
```

#### Acceptance criteria

- [ ] `pnpm install` succeeds
- [ ] `pnpm build` compiles all packages without errors
- [ ] `pnpm test` runs and passes (even if only 1 trivial test per package)
- [ ] `pnpm lint` passes
- [ ] CI pipeline runs green on push
- [ ] `pnpm --filter @media-router/manager-ui dev` starts Vite dev server with theme visible
- [ ] `shared-types` exports all interfaces and they're importable from other packages

---

### Phase 1 — Communication Layer

**Goal:** dgram-comms v2 package — encrypted, fragmented, multi-path UDP communication between engine and manager.

#### Tasks

| # | Task | Details | URS | FDS |
|---|------|---------|-----|-----|
| 1.1 | Encryption module | AES-256-CBC with per-message random IV. Key derived from shared password via SHA-256. Key cache (password→key Map) to avoid re-deriving. `encrypt(plaintext, password) → Buffer`, `decrypt(ciphertext, password) → Buffer` | UR-COM-004 | §8.1.1 |
| 1.2 | Fragmentation module | Split messages >1412 bytes into numbered chunks. Each fragment: `[messageId: 4B][fragmentIndex: 2B][fragmentCount: 2B][payload]`. Reassembly buffer with timeout (5s). Dedup by messageId. `fragment(data) → Buffer[]`, `Reassembler` class | UR-COM-005 | §8.1.1 |
| 1.3 | Socket class | Wraps a single UDP socket (dgram). Handles: encryption → fragmentation → send, and receive → reassembly → decryption. Guaranteed delivery: outgoing messages get ACK IDs, resend after 200ms/400ms/800ms/1600ms. Keepalive every 5s. Topic-based event emitter: `socket.emit(topic, message)`, `socket.on(topic, handler)`. Connection state tracking (connected/disconnected) | UR-COM-001, UR-COM-006 | §8.1.1 |
| 1.4 | Server class | Listens on UDP port. Tracks connected clients by `clientId`. NAT handling: update client address on each received packet. Validates client credentials against provided password map. Emits `connection(socket)` when new client authenticates. `server.broadcast(topic, message)` sends to all connected clients. `server.sendTo(clientId, topic, message)` targets one | UR-COM-001 | §8.1.1 |
| 1.5 | Client class | Connects to server via 1–N UDP paths (for redundancy). Each path = separate UDP socket to different IP/port. Sends every message on ALL paths. Receives from any path (dedup by messageId). Automatic reconnection every 5s on disconnect. Optional interface binding per path. `client.send(topic, message)` sends on all paths. Emits `data(topic, message)` on receive | UR-COM-002, UR-COM-003 | §8.1.2 |
| 1.6 | Path health tracking | Each path tracks: last packet received timestamp, RTT (from ACK), packet loss ratio. Path considered dead after 15s no response. Client continues on remaining paths. Emits `pathDown(pathIndex)` / `pathUp(pathIndex)` | UR-COM-002 | §8.1.2 |
| 1.7 | Unit tests | Test encryption round-trip, fragmentation/reassembly, guaranteed delivery (mock timers), multi-path dedup. ≥90% coverage for this package | UR-TST-003 | §12.2 |

#### Acceptance criteria

- [ ] Client connects to Server, exchanges encrypted messages
- [ ] Messages >1412 bytes fragment and reassemble correctly
- [ ] Lost packets are retransmitted (test by dropping random ACKs)
- [ ] Client sends on 2 paths, server receives deduped messages
- [ ] Client reconnects automatically after server restart
- [ ] Path health emits pathDown after 15s silence
- [ ] All unit tests pass

---

### Phase 2 — Engine Core

**Goal:** Engine process starts, discovers plugins, manages module lifecycle, serves Local API. No GStreamer yet — modules are started/stopped but don't run media pipelines.

#### Tasks

| # | Task | Details | URS | FDS |
|---|------|---------|-----|-----|
| **Plugin System** | | | | |
| 2.1 | PluginLoader | Scan `plugins/` directory. For each subdirectory: read `package.json`, validate `mediaRouter` manifest (pluginId, displayName, ports, configSchema, engine path). Filter by current architecture (arm64/x86_64). Dynamic `require()` of engine module. Return `Map<pluginId, PluginConstructor>` | UR-PLG-001, UR-PLG-002 | §9.1, §9.2, §9.6 |
| 2.2 | PluginModule interface | Define the contract every plugin implements: `onInit(config)`, `onStart()`, `onStop()`, `onDestroy()`, `getState() → ModuleRuntimeState`, `getLiveUpdatableParams() → string[]`, `onLiveConfigUpdate(changes)`. Export from engine package | UR-PLG-003 | §9.4 |
| 2.3 | GstPluginBase class | Abstract base class implementing PluginModule. Manages: pipeline state tracking, VU data forwarding, error tracking, health status. Subclasses override `buildPipeline(config) → PipelineDescription`. Provides `setElementProperty(element, prop, value)` for live updates | UR-PLG-003 | §9.4 |
| **Module Management** | | | | |
| 2.4 | ModuleInstance | Wraps a PluginModule with: instanceId, pluginId, config, `ModuleRuntimeState` (running, health, error, vuData, pendingRestart). State change events via EventEmitter. `start()`, `stop()`, `applyConfigUpdate(changes)` | UR-ENG-007 | §5.2 |
| 2.5 | ModuleManager | Manages all ModuleInstances. `createModule(instanceId, pluginId, config)`, `startModule(id)`, `stopModule(id)`, `deleteModule(id)`, `stopAll()`. Tracks all instances in a Map. Forwards state changes to engine | UR-ENG-008 | §3.1 |
| 2.6 | Module lifecycle serialisation | Per-module operation queue (using `p-queue` or manual). Only one lifecycle operation (start/stop/restart/config) at a time per module. Prevents race conditions | — | §3.6.1 |
| **Routing** | | | | |
| 2.7 | MediaRouter | Routing graph. `registerPorts(moduleId, ports[])` — register a module's input/output ports. `createConnection(sourceModule, sourcePort, sinkModule, sinkPort)` — validate compatibility, create link. `removeConnection(connId)`. Three routing domains: `audio/pcm` (PipeWire linking), `muxed/mpegts` (stdin/stdout piping), `video/raw` (FIFO piping). Port compatibility: source.streamType must match sink.streamType | UR-ENG-002 | §3.2.4 |
| 2.8 | Port compatibility validation | Check stream type match. For `muxed/mpegts`: optionally check codec compatibility via `MpegTsStreamInfo`. For `audio/pcm`: check channel count. Return `{ compatible: boolean, reason?: string }` | UR-ENG-008 | §3.2.3 |
| **Local API** | | | | |
| 2.9 | Fastify server | Engine starts Fastify on configurable port (default 3001). Register route modules. CORS enabled for localhost. OpenAPI spec via `@fastify/swagger` | UR-API-001 | §7.1 |
| 2.10 | Health endpoint | `GET /api/v1/health` — returns `{ status: 'ok', uptime, moduleCount, memoryUsage }` | UR-OBS-004 | §11.2 |
| 2.11 | System info endpoint | `GET /api/v1/system` — returns hostname, platform, arch, cpus, totalMemory, nodeVersion, gstreamerVersion | UR-API-004 | §7.2 |
| 2.12 | Engine control endpoints | `POST /api/v1/engine/start`, `POST /api/v1/engine/stop`, `POST /api/v1/engine/restart`, `GET /api/v1/engine/status` | UR-API-004 | §7.2 |
| 2.13 | Profile CRUD endpoints | `GET /api/v1/profiles`, `POST /api/v1/profiles`, `GET /api/v1/profiles/:name`, `PUT /api/v1/profiles/:name`, `DELETE /api/v1/profiles/:name`, `POST /api/v1/profiles/:name/activate`. Store profiles as JSON files in engine config directory | UR-API-010–016 | §7.3 |
| 2.14 | Audio device endpoints | `GET /api/v1/audio/devices` — list PipeWire sources and sinks. `GET /api/v1/audio/devices/:id` — detail. (Stub responses until Phase 5 PipeWire integration) | UR-API-030 | §7.5 |
| **Communication** | | | | |
| 2.15 | ManagerConnection | Wraps dgram-comms Client. `connect(profile: ManagerConnectionProfile)`. Forwards: manager config → ModuleManager, module state → manager, VU data → manager. Handles `config`, `command`, `state` topics. Auto-connect on engine start using active profile | UR-COM-007 | §3.7 |
| 2.16 | LcpServer | Socket.IO server on port 8081. Broadcasts module state to all LCP clients. Receives control commands (volume, start/stop, mute) from LCP. Forwards to ModuleManager and ManagerConnection | UR-COM-020 | §8.3 |
| **Process** | | | | |
| 2.17 | Engine entry point | `src/index.ts`. Creates Engine instance, starts Fastify, starts LcpServer, auto-connects to manager if active profile exists. Graceful shutdown on SIGTERM/SIGINT: stop all modules → disconnect manager → close servers | UR-ENG-001 | §3.1 |
| 2.18 | Unit tests | PluginLoader (mock fs), ModuleManager (mock plugins), MediaRouter (port compat), Local API routes (supertest). ≥80% coverage | UR-TST-003 | §12.2 |

#### Acceptance criteria

- [ ] `node v2/packages/engine/dist/index.js` starts without errors
- [ ] Local API serves on port 3001: `/api/v1/health`, `/api/v1/system`, `/api/v1/profiles`
- [ ] Profile CRUD works: create → list → activate → delete
- [ ] PluginLoader discovers `example-plugin` and reports its manifest
- [ ] ModuleManager can create/start/stop a module instance (no-op plugin)
- [ ] LcpServer accepts Socket.IO connections on port 8081
- [ ] Engine auto-connects to manager if active profile configured
- [ ] Graceful shutdown: SIGTERM stops modules, closes servers, exits 0
- [ ] All unit tests pass

---

### Phase 3 — GStreamer Child Process Runtime

**Goal:** Engine can spawn GStreamer pipelines in child processes, communicate via IPC, receive VU/state data, and change properties live.

**Why this phase exists separately:** Every media plugin depends on this. Getting the child process lifecycle right before building plugins prevents cascading bugs.

#### Tasks

| # | Task | Details | URS | FDS |
|---|------|---------|-----|-----|
| 3.1 | `gst-runner.ts` child script | Standalone Node.js script spawned by the engine. Receives pipeline description via IPC (`process.send`). Builds and runs GStreamer pipeline via `gst-launch-1.0` (or node-gstreamer-superficial bindings). Reports state changes (NULL→READY→PAUSED→PLAYING→EOS→ERROR) back to parent. Stays alive until parent sends `stop` command or parent dies | UR-ENG-003 | §3.5 |
| 3.2 | ControlIpc class | Typed IPC layer between parent and child. JSON messages with `{ id, type, action, data }`. Request/response correlation by ID. 10-second timeout on requests. Message types: `startPipeline`, `stopPipeline`, `setElementProperty`, `getStats`, `stateChange` (child→parent), `vuData` (child→parent), `error` (child→parent) | UR-ENG-002 | §3.6.1–3.6.4 |
| 3.3 | GstChildProcess class | Wraps `child_process.fork()` of `gst-runner.ts`. Provides: `start(pipelineDesc)`, `stop()`, `setElementProperty(element, prop, value)`, `getStats(element)`. Emits: `stateChange`, `vuData`, `error`, `exit`. Restart policy: exponential backoff (3s→6s→12s→60s cap). Reset counter after 30s stable | UR-ENG-004 | §3.5 |
| 3.4 | ChildProcessManager | Registry of all active child processes. `spawn(scriptPath, args) → ChildHandle`. `killAll()` on engine shutdown. Orphan detection: on engine stop, check for leaked PIDs. `getActiveCount()` for health reporting | — | §3.6.7 |
| 3.5 | VU meter extraction | In `gst-runner.ts`: add `level` element to audio pipelines. Parse `level` bus messages for peak/RMS per channel. Forward to parent via IPC at ~15Hz. Data format: `{ channels: number[], peak: number[], rms: number[] }` | UR-ENG-007 | §5.3.3 |
| 3.6 | Media IPC — stdin/stdout piping | For MPEG-TS routing between modules: child process writes to stdout, another reads from stdin. Engine's MediaRouter connects these file descriptors. Use `{ stdio: ['pipe', 'pipe', 'pipe', 'ipc'] }` in fork options | UR-ENG-002 | §3.2.1 |
| 3.7 | Graceful shutdown | Parent sends `stopPipeline` via IPC → child sets pipeline to NULL → child exits. If no exit after 5s: SIGTERM. If no exit after 10s: SIGKILL. Clean up temp FIFOs if any | — | §3.6.6 |
| 3.8 | Integration test | Spawn `gst-runner` with `audiotestsrc ! level ! fakesink` pipeline. Verify: state reaches PLAYING, VU data received, `setElementProperty` changes freq, pipeline stops cleanly | UR-TST-004 | §12.2 |

#### Acceptance criteria

- [ ] `gst-runner.ts` spawns, receives pipeline JSON, starts GStreamer
- [ ] State transitions (NULL→PLAYING) reported to parent via IPC
- [ ] VU data received at ≥10Hz from `level` element
- [ ] `setElementProperty` changes a live parameter without restart
- [ ] Child auto-restarts on crash with exponential backoff
- [ ] No orphan `gst-launch` processes after engine shutdown
- [ ] stdout/stdin piping works between two child processes
- [ ] Integration test passes

---

### Phase 4 — Manager Core

**Goal:** Manager process running with SQLite config store, engine connections via dgram-comms, browser UI proxying via Socket.IO.

#### Tasks

| # | Task | Details | URS | FDS |
|---|------|---------|-----|-----|
| **Config Store** | | | | |
| 4.1 | SQLite database setup | better-sqlite3 with WAL mode. Three tables: `engines` (engine_id PK, display_name, password, active_profile, created_at, updated_at), `engine_profiles` (engine_id + profile_name PK, config JSON blob), `engine_config_history` (id, engine_id, profile_name, config JSON, saved_at). Auto-create on first run | UR-MGR-002 | §4.2.1 |
| 4.2 | ConfigStore class | Engine CRUD: create, get, getAll, update, delete. Profile CRUD: create, get, getAll, update, delete, setActive. Version history: saveVersion (10-min debounce), getHistory (last 10). Config is stored as JSON string. `INSERT OR IGNORE` for idempotent profile creation. Cascade delete profiles when engine deleted | UR-MGR-002, UR-MGR-004 | §4.2.1, §4.2.3 |
| 4.3 | Config version history | On `updateProfileConfig()`: check time since last snapshot. If >10 min: save current config as version before applying update. Prune to keep max 10 versions per engine/profile. `getVersionHistory(engineId, profile)` returns list with timestamps | UR-MGR-005 | §4.2.4 |
| **Engine Connections** | | | | |
| 4.4 | EngineConnectionManager | Wraps dgram-comms Server. On new client connection: validate engineId + password against ConfigStore. Track online/offline status. Push active profile config to engine on connect. Forward engine state updates to Socket.IO. `sendToEngine(engineId, topic, message)` for targeted commands. `isEngineOnline(id)`. `refreshEncryptionKeys()` when passwords change | UR-MGR-006 | §4.5 |
| 4.5 | Engine reconnection handling | When engine reconnects: push full active profile config (not just delta). Update online status. Emit `engine:online` to all browser clients | UR-COM-007 | §3.7 |
| **Socket.IO (Manager↔Browser)** | | | | |
| 4.6 | Socket.IO server | Attach to Express HTTP server. CORS: allow all origins (dev). On `connection`: send `engine:list` with full state (engine metadata + active profile modules + connections). Register event handlers | UR-COM-010 | §8.2.1 |
| 4.7 | Engine state events | Forward `engineOnline`, `engineOffline`, `engineState` from EngineConnectionManager → Socket.IO → all browser clients. Engine state includes system info, module states, VU data | UR-COM-011 | §8.2.1 |
| 4.8 | Delta updates (JSON Patch) | When module/connection changes: emit `engine:update` with RFC 6902 patch array. Browser applies patches to local Pinia store. Patches for: add/remove module, add/remove connection, module state change, position update | UR-COM-012 | §8.2.2 |
| 4.9 | Module management handlers | `module:add` — look up plugin manifest, build default settings from configSchema, store in profile config (with ports, configSchema, settings), broadcast patch. `module:delete` — remove from config + remove related connections, broadcast patches. `module:position` — update position in config (no broadcast needed, just persist) | — | §5.3 |
| 4.10 | Routing connection handlers | `routing:connect` — validate, store connection in profile config under `connections[]`, broadcast patch. `routing:disconnect` — remove, broadcast. Connection ID format: `sourceModule:sourcePort-sinkModule:sinkPort` | — | §5.3.2 |
| 4.11 | Module control handlers | `module:toggle` (start/stop), `module:restart` — forward to engine via dgram-comms. `module:config` — update settings in profile config, forward to engine, broadcast patch | — | §5.3.3 |
| **REST API** | | | | |
| 4.12 | Engine CRUD endpoints | `POST /api/v1/engines` (register — creates engine + default profile + sets active), `PUT /api/v1/engines/:id` (update name/password), `DELETE /api/v1/engines/:id`. Broadcast Socket.IO events on change | — | §4.1 |
| 4.13 | Profile endpoints | `GET /api/v1/engines/:id/profiles`, `POST .../profiles` (create), `DELETE .../profiles/:name`, `POST .../profiles/:name/activate`. Version history: `GET .../profiles/:name/history` | UR-MGR-004 | §4.2.3 |
| 4.14 | Plugin listing endpoint | `GET /api/v1/plugins` — scan `plugins/` directory, read `package.json` manifests, return array of `{ pluginId, displayName, description, category, ports, configSchema }` | UR-PLG-001 | §9.6 |
| 4.15 | Static file serving | Serve `manager-ui/dist/` as static files. SPA fallback: all non-`/api` routes return `index.html`. If dist doesn't exist: show "run pnpm build" message | — | §5.1 |
| **Process** | | | | |
| 4.16 | Manager entry point | `src/index.ts`. Creates Manager, starts dgram-comms on port 3000, starts HTTP+Socket.IO on port 8080. Graceful shutdown: stop dgram-comms → close Socket.IO → close HTTP → close SQLite | UR-MGR-001 | §4.1 |
| 4.17 | Unit tests | ConfigStore CRUD, EngineConnectionManager (mock dgram), Socket.IO handlers (mock socket). ≥80% coverage | UR-TST-003 | §12.2 |

#### Key implementation notes

- When `engine:list` is sent on browser connect, it MUST include modules and connections from the active profile config — not just engine metadata
- When a module is added (`module:add`), store `ports` and `configSchema` from the plugin manifest alongside the module config in SQLite. The browser needs this to render port handles and settings forms
- Build default settings values from `configSchema.properties[*].default` when creating a module
- Use `INSERT OR IGNORE` for profile creation to avoid PK constraint errors on re-creation

#### Acceptance criteria

- [ ] `node v2/packages/manager/dist/index.js` starts without errors
- [ ] Manager serves on port 8080, dgram-comms on 3000
- [ ] `POST /api/v1/engines` registers an engine with default profile
- [ ] Engine connects to manager via dgram-comms, shows as online
- [ ] Browser connects via Socket.IO, receives `engine:list` with modules
- [ ] Add module from browser → persists in SQLite → broadcast to all browsers → survives page reload
- [ ] Create connection from browser → persists → survives reload
- [ ] Delete module → removes connections → broadcasts patches
- [ ] Config version history records snapshots with 10-min debounce

---

### Phase 5 — Core Audio Plugins

**Goal:** Audio encoding and decoding via GStreamer child processes. PipeWire audio routing between modules.

#### Tasks

| # | Task | Details | URS | FDS |
|---|------|---------|-----|-----|
| **PipeWire** | | | | |
| 5.1 | PipeWireManager | Utility class for PipeWire operations. `listDevices()` — parse `pw-dump` output for audio sources/sinks. `createLink(sourceNode, sourcePort, sinkNode, sinkPort)` — call `pw-link`. `removeLink(...)` — call `pw-link -d`. `getLinks()` — list active links. Error handling for each operation. Idempotent: creating existing link is a no-op | UR-ENG-005 | §3.2.5 |
| 5.2 | Audio device enumeration | Implement `GET /api/v1/audio/devices` using PipeWireManager.listDevices(). Return: name, description, channels, sampleRate, direction (source/sink) | UR-ENG-006 | §3.2.5 |
| 5.3 | AudioDeviceSettings | Per-device config: sample rate, bit depth, buffer size. Store in engine profile. Apply on engine start via `pw-metadata` or `pw-cli` | UR-ENG-006a | §3.2.5 |
| 5.4 | Audio routing in MediaRouter | When `createConnection()` is called for `audio/pcm` ports: call PipeWireManager.createLink(). When `removeConnection()`: call removeLink(). Map moduleId+portId to PipeWire node names | UR-ENG-005 | §3.2.4 |
| **Plugins** | | | | |
| 5.5 | AudioEncoder plugin manifest | `package.json` with `mediaRouter`: pluginId `audio-encoder`, category `codec`, ports `[{id: 'audio-in', direction: 'input', streamType: 'audio/pcm'}, {id: 'mpegts-out', direction: 'output', streamType: 'muxed/mpegts'}]`, configSchema with codec (enum: aac/opus/mp2), bitrate (number, x-liveUpdatable), sampleRate (enum: 44100/48000), channels (enum: 1/2) | UR-ENG-010 | §3.3.2 |
| 5.6 | AudioEncoder `buildPipeline()` | `pulsesrc` (PipeWire compat) → `audioconvert` → `audioresample` → codec encoder (`opusenc`/`fdkaacenc`/`twolameenc`) → `mpegtsmux` → `fdsink fd=1`. Codec selected by config. Bitrate live-updatable via `setElementProperty` on encoder element | UR-ENG-010 | §3.3.2 |
| 5.7 | AudioDecoder plugin manifest | Ports: `[{mpegts-in, input, muxed/mpegts}, {audio-out, output, audio/pcm}]`. Config: outputDevice (string) | UR-ENG-011 | §3.3.2 |
| 5.8 | AudioDecoder `buildPipeline()` | `fdsrc fd=0` → `tsdemux` → auto-detect codec → decoder (`opusdec`/`faad`/`mad`) → `audioconvert` → `pulsesink` (PipeWire). Auto-detect by reading tsdemux pad caps | UR-ENG-011 | §3.3.2 |
| 5.9 | Integration test — encode/decode round-trip | PipeWire source → AudioEncoder → pipe → AudioDecoder → PipeWire sink. Verify audio plays through. Measure latency | UR-TST-004 | §12.2 |

#### Acceptance criteria

- [ ] AudioEncoder produces MPEG-TS audio stream (verifiable with `ffprobe`)
- [ ] AudioDecoder plays MPEG-TS audio to PipeWire output
- [ ] Codec selection works: Opus, AAC, MP2
- [ ] Bitrate changes live without pipeline restart
- [ ] PipeWire devices listed via `/api/v1/audio/devices`
- [ ] PipeWire links created/removed when modules connect/disconnect
- [ ] Encode→decode round-trip produces audible output

---

### Phase 6 — Protocol Plugins: SRT & RIST

**Goal:** SRT and RIST input/output modules fully functional with stats.

#### Tasks

| # | Task | Details | URS | FDS |
|---|------|---------|-----|-----|
| 6.1 | SrtInput `buildPipeline()` | `srtsrc uri=srt://host:port?mode=listener` → `queue` → `fdsink fd=1`. Config: host, port, mode (listener/caller), latency, streamId, passphrase, pbKeyLen. Live-updatable: none (pipeline restart required for address changes) | UR-ENG-016, UR-ENG-017 | §3.4.1 |
| 6.2 | SrtOutput `buildPipeline()` | `fdsrc fd=0` → `queue` → `srtsink uri=srt://host:port?mode=caller`. Config: host, port, mode, latency, passphrase | UR-ENG-018 | §3.4.1 |
| 6.3 | SRT statistics | Poll `srtsrc`/`srtsink` `stats` property every 2s in gst-runner. Parse JSON stats. Forward: bitrate, RTT, loss, retransmits, connection count. Include in ModuleRuntimeState.stats | UR-OBS-006 | §11.3 |
| 6.4 | SRT multipoint | SrtInput in listener mode accepts multiple callers (configurable `max-connections`). Each caller gets the same MPEG-TS stream | UR-ENG-016 | §3.4.1 |
| 6.5 | RistInput `buildPipeline()` | `ristsrc address=rist://host:port` → `queue` → `fdsink fd=1`. Config: host, port, bonding addresses. Multi-link: multiple source addresses for redundancy | UR-ENG-020 | §3.4.2 |
| 6.6 | RistOutput `buildPipeline()` | `fdsrc fd=0` → `queue` → `ristsink address=rist://host:port`. Config: host, port, bonding addresses | UR-ENG-020 | §3.4.2 |
| 6.7 | RIST statistics | Poll ristsrc/ristsink for quality metrics. Forward to parent | UR-OBS-006 | §11.3 |
| 6.8 | SRT loopback test | SrtOutput → network → SrtInput on same device. Verify stream integrity. Test encryption. Test caller/listener modes | UR-TST-004 | §12.2 |
| 6.9 | SRT relay test | SrtInput (receive) → MPEG-TS pipe → SrtOutput (send). Verify relay works without dedicated relay module | — | §3.4.1 |

#### Acceptance criteria

- [ ] SrtInput receives SRT stream in listener and caller modes
- [ ] SrtOutput sends MPEG-TS over SRT
- [ ] SrtInput → SrtOutput relay works (no dedicated module needed)
- [ ] SRT encryption (passphrase) works
- [ ] SRT stats (bitrate, RTT, loss) available in module state
- [ ] RistInput/RistOutput exchange MPEG-TS over RIST
- [ ] Loopback and relay tests pass

---

### Phase 7 — Protocol Plugins: HLS & Stream Probing

**Goal:** HLS playback with fMP4 support, automatic MPEG-TS stream content detection.

#### Tasks

| # | Task | Details | URS | FDS |
|---|------|---------|-----|-----|
| 7.1 | HlsPlayer `buildPipeline()` | `souphttpsrc location=URL` → `hlsdemux` → auto-detect segment type → `tsdemux`/`qtdemux` → re-mux to MPEG-TS → `fdsink fd=1`. For fMP4: `qtdemux` → `h264parse` → `mpegtsmux`. Config: hlsUrl, videoQuality, audioLanguage, subtitleLanguage | UR-ENG-023 | §3.4.4 |
| 7.2 | fMP4/CMAF support | Detect segment type from hlsdemux. If fMP4: route through qtdemux → parsers → mpegtsmux. If MPEG-TS: passthrough. Handle variant playlist (ABR) with quality selection | UR-ENG-023a | §3.4.4 |
| 7.3 | Resolution change handling | When HLS stream switches resolution: handle caps renegotiation in pipeline. If pipeline can't renegotiate: tear down and rebuild. Emit warning to UI | UR-ENG-023a | §3.4.4 |
| 7.4 | Optional SRT re-encode | When `enableSrt=true` and `srtReencode=true`: add video encoder (software/hardware) + `srtsink` branch. Config: videoBitrate (live-updatable), videoFramerate, videoEncoder (auto/software/hardware), subtitleLanguage for burn-in | UR-ENG-023a | §3.4.4 |
| 7.5 | StreamProbe | Utility class. Takes MPEG-TS data (from fd or file). Uses `gst-discoverer` or `tsdemux` to detect: video streams (codec, resolution, framerate), audio streams (codec, channels, sampleRate). Returns `MpegTsStreamInfo`. Cache results for 30s | UR-ENG-015 | §3.2.7 |
| 7.6 | Auto-probe on output ports | When a module starts producing MPEG-TS: probe the stream. Populate the output port's `streamInfo`. Emit to manager so UI can display codec/resolution badges on ports | UR-ENG-015 | §3.2.1 |
| 7.7 | Port compatibility validation | In MediaRouter.createConnection(): if both ports are `muxed/mpegts`, optionally check codec compatibility via streamInfo. Warn if mismatch but don't block (user override) | UR-ENG-008 | §3.2.3 |
| 7.8 | HLS integration test | Play known HLS URL. Verify MPEG-TS output with `ffprobe`. Test with both TS and fMP4 segment sources | UR-TST-004 | §12.2 |

#### Acceptance criteria

- [ ] HlsPlayer outputs MPEG-TS from an HLS URL
- [ ] fMP4 segments auto-detected and transmuxed to MPEG-TS
- [ ] Quality selection (720p, 1080p, etc.) works
- [ ] Resolution changes don't crash the pipeline
- [ ] StreamProbe returns video codec/resolution and audio codec/channels
- [ ] Stream info visible on module output ports

---

### Phase 8 — Audio Processing Plugins

**Goal:** N-1 mixer, sound processor (EQ/compressor/gate), sound ducking.

#### Tasks

| # | Task | Details | URS | FDS |
|---|------|---------|-----|-----|
| 8.1 | AudioMixer plugin | PipeWire-based multi-input mixer. 4 inputs (`audio-in-1` through `audio-in-4`) + 1 output (`audio-out`). Per-input volume (0.0–1.5, live-updatable). Master volume (live-updatable). Uses PipeWire's `audiomixer` or `adder` element | UR-ENG-025 | §3.3.1 |
| 8.2 | N-1 mixer logic | For broadcast monitoring: pair inputs with outputs. Each paired output gets a mix excluding its own input. E.g., Output-1 = Input-2 + Input-3 + Input-4 (excludes Input-1). Configurable pairing via config | UR-ENG-025 | §3.3.1 |
| 8.3 | SoundProcessor plugin | GStreamer pipeline: `pulsesrc` → `equalizer-10bands` → `audiodynamic` (compressor mode) → `audiodynamic` (gate mode) → `pulsesink`. Config: 10 EQ band gains (-24 to +12 dB), compressor threshold/ratio/attack/release, gate threshold. All live-updatable | UR-ENG-026 | §3.3.1 |
| 8.4 | SoundDucking plugin | GStreamer pipeline with sidechain. Main audio path + sidechain input. When sidechain level exceeds threshold: reduce main volume. Config: threshold (-60 to 0 dB), duckLevel (0.0–1.0), attack (ms), release (ms). Live-updatable | UR-ENG-027 | §3.3.1 |

#### Acceptance criteria

- [ ] AudioMixer mixes 4 inputs with per-input volume
- [ ] N-1 exclusion works correctly
- [ ] SoundProcessor applies EQ + compressor + gate audibly
- [ ] SoundDucking reduces main audio when sidechain is active
- [ ] All processing params live-updatable without pipeline restart

---

### Phase 9 — Manager Web UI

**Goal:** Complete Vue 3 web application for managing engines, routing, profiles, and settings.

#### Tasks

| # | Task | Details | URS | FDS |
|---|------|---------|-----|-----|
| **App Shell** | | | | |
| 9.1 | Vue 3 + Vue Router + Pinia scaffold | Routes: `/engines`, `/engines/:id`, `/routing/:engineId`, `/profiles/:engineId`, `/settings`, `/login`. Layouts: sidebar + header + main content | UR-UI-001 | §5.1 |
| 9.2 | Socket.IO Pinia store | `useSocketStore()` — connect, disconnect, emit. On connect: receive `engine:list`. Listen for: `engine:update` (patches), `engine:online/offline`, `engine:added/updated/removed`. Reconnection with backoff | UR-COM-010 | §8.2.1 |
| 9.3 | Engine Pinia store | `useEngineStore()` — `engines: Map<string, EngineState>`. `addEngine()`, `applyEnginePatch()` (RFC 6902 — handle `add`, `replace`, `remove`, `-` for array append), `setOnline()`, `removeEngine()`. When receiving engine:list: include modules/connections from server. Trigger Vue reactivity by creating new Map on mutations | UR-COM-012 | §8.2.2 |
| 9.4 | Theme store | `useThemeStore()` — dark/light toggle, persisted in localStorage. Apply `.dark` class to `<html>` | UR-UI-006 | §5.5.1 |
| 9.5 | Header component | App logo, connection status indicator (green/red dot), theme toggle | — | §5.1 |
| 9.6 | Sidebar component | Navigation links: Engines, Settings. Active route highlighted | — | §5.1 |
| **Component Library** | | | | |
| 9.7 | MrButton | Variants: primary (accent), secondary (border), danger (red). Sizes: sm, md. Loading state with spinner | — | §5.5 |
| 9.8 | MrInput | Text input with label, error state, CSS variable styling | — | §5.5 |
| 9.9 | MrModal | Teleported dialog with backdrop blur, title, body slot, footer slot (actions) | — | §5.5 |
| 9.10 | MrSlider | Range input with value display. Used for volume, zoom | — | §5.5 |
| 9.11 | MrVuMeter | Canvas2D horizontal VU meter. Props: levels[], width, height. Green/yellow/red zones. 60fps animation. Clickable (emits click for volume popup) | — | §5.5 |
| 9.12 | MrContextMenu | Fixed-position menu on right-click. Teleported to body. Items with label, action, disabled, danger, divider. Click-outside to close. Themed with CSS vars | — | §5.5 |
| 9.13 | MrSelect | Dropdown with search filter | — | §5.5 |
| 9.14 | MrToggle | On/off switch | — | §5.5 |
| 9.15 | MrTabs | Tab navigation component | — | §5.5 |
| **Routing Editor** | | | | |
| 9.16 | Vue Flow integration | Install `@vue-flow/core`. Use `useVueFlow()` composable for `setNodes()`, `setEdges()`, `addEdges()`, `fitView()`, `zoomTo()`, `setCenter()`. Do NOT pass nodes/edges as props (Vue Flow ignores prop changes). Use `watch` on store to call `setNodes`/`setEdges` imperatively | UR-UI-010 | §5.3.1 |
| 9.17 | Node sync strategy | Watch `moduleIds` (computed as sorted key string). Only call `setNodes()` when IDs change (add/remove). Do NOT use `deep: true` — it causes jumping on every property change. For property updates (health, VU): update node data directly via Vue Flow API | — | §5.3.1 |
| 9.18 | Edge sync strategy | Watch `connectionIds` (computed as sorted ID string). Call `setEdges()` when IDs change. For immediate feedback on connect: call `addEdges()` locally before server confirms | — | §5.3.2 |
| 9.19 | ModuleNode component | Custom Vue Flow node. Fixed width 200px. Header: health dot + display name. Body: input port labels (left) + output port labels (right). Port dots coloured by stream type. VU meter bar (if vuData). Error text. CSS variable themed | UR-UI-011 | §5.3.1 |
| 9.20 | Port handles | Vue Flow `<Handle>` components. Input handles: type=target, Position.Left. Output handles: type=source, Position.Right. Positioned with pixel offsets (not %) aligned to port label rows. Styled: 12px circles, coloured by stream type, 2px border matching card background | UR-UI-013 | §5.3.1 |
| 9.21 | Connection interaction | `@connect` event on VueFlow → add edge locally + emit `routing:connect`. Drag from output handle to input handle. Connection line colour = accent while dragging. Port compatibility: highlight valid targets (TODO: Phase 12) | UR-UI-012, UR-UI-014 | §5.3.2 |
| 9.22 | Context menu | `@node-context-menu` event on VueFlow (NOT composable). Items: Start/Stop, Restart, Settings, Copy, Delete. Handle both MouseEvent and TouchEvent. Long-press for mobile (500ms timeout) | UR-UI-016b | §5.3.3 |
| 9.23 | Settings panel | Fixed-position right panel (not absolute — must not scroll with canvas). Opens on double-click or context menu → Settings. Generates form from module's `configSchema`: dropdowns for enums, toggles for booleans, number inputs, text inputs. Shows description per field. Lightning bolt for `x-liveUpdatable` fields. Apply All button | — | §5.3.3 |
| 9.24 | Add Module panel | Fixed-position right panel. Fetches `/api/v1/plugins`. Groups by category. Search filter. Click plugin → detail view with ports and config info. "Add Module" button emits `module:add` | — | — |
| 9.25 | Module finder | Toolbar dropdown showing all modules by name. Click to `setCenter()` on that module's position. Shows module count badge | — | §5.3.3 |
| 9.26 | Zoom controls | Fit View button, Reset button, zoom slider (20%–200%). Prevent browser zoom on canvas (Ctrl+wheel intercept via non-passive wheel listener). Auto-fitView on first load (with 200ms retry) | UR-UI-015 | §5.3.3 |
| 9.27 | VU meter in nodes | Receive vuData from engine state. Render with MrVuMeter in module node body. Click → popup MrSlider for volume (emits `module:config` with volume change) | UR-UI-016, UR-UI-016c | §5.3.3 |
| **Engine Dashboard** | | | | |
| 9.28 | Engines list view | Card per engine: name, online/offline dot, active profile name. "Register Engine" button → modal. Empty state with CTA. Search/filter. Click card → detail view | UR-UI-020 | §5.4 |
| 9.29 | Engine detail view | Info rows: ID, status, running, active profile, module count, connection count. Edit button → modal (display name, password). Delete button → confirmation. Links to routing editor and profile manager | UR-UI-023 | §5.4 |
| 9.30 | Engine start/stop | Button on detail view. Emits Socket.IO event → Manager → Engine via dgram-comms | — | §5.4 |
| **Profile Management** | | | | |
| 9.31 | Profiles view | List profiles for engine. Active has "Live" badge (green). Others have amber indicator. Create button → name input. Switch button → confirmation dialog. Delete button (can't delete active) | UR-MGR-004 | §4.2.3 |
| 9.32 | Non-active profile editing | When editing non-active profile: amber banner "Editing non-active profile — changes won't apply until activated". Routing editor border/background tint | UR-MGR-025 | §4.3 |
| 9.33 | Config version history | View last 10 versions with timestamps. Click to preview (JSON display). Rollback button → confirmation → restores config | UR-MGR-005 | §4.2.4 |
| 9.34 | Import/export | Export: download active profile as JSON file. Import: upload JSON → create new profile or overwrite | UR-MGR-007 | §4.2 |
| **Settings** | | | | |
| 9.35 | Settings view | Dark/light theme toggle. Manager connection info display. About section with version | UR-UI-006 | §5.5.1 |

#### Acceptance criteria

- [ ] Full app navigable: engines list → detail → routing editor → profiles
- [ ] Modules appear as nodes with coloured port handles (left=input, right=output)
- [ ] Drag output→input creates connection line, persists to server
- [ ] Right-click shows context menu, double-click opens settings panel
- [ ] Settings panel generates form from configSchema with proper input types
- [ ] Module finder dropdown navigates to any module
- [ ] VU meters animate in real-time in module nodes
- [ ] Engine register/edit/delete works
- [ ] Profile create/switch/delete works
- [ ] Config history shows versions with rollback
- [ ] Import/export produces valid JSON
- [ ] All panels are fixed position (don't scroll with canvas)
- [ ] Zoom/pan/fit-view/reset all work
- [ ] Dark theme correct everywhere
- [ ] No modules "lost" off-screen — auto-fit on first load

---

### Phase 10 — Local Control Panel

**Goal:** Operator-facing mixer UI with vertical faders, VU meters, and mute buttons on port 8081.

#### Tasks

| # | Task | Details | URS | FDS |
|---|------|---------|-----|-----|
| 10.1 | Vue 3 app scaffold | Vite + Vue 3 + Pinia + Tailwind. Port 8081. Same dark theme CSS variables. `index.html` with `user-scalable=no` for kiosk mode | UR-LCP-001 | §6.1 |
| 10.2 | Engine state store | Socket.IO connection to engine on `localhost:8081`. Receive module states, VU data. Send volume/mute/start/stop commands back | UR-LCP-002 | §8.3 |
| 10.3 | Mixer layout | Full-height view. Vertical faders in a row. Each fader = one audio module. Fader height = viewport height - header. Channel strip: label at top, VU meter, fader, mute button at bottom | UR-LCP-003 | §6.2 |
| 10.4 | Vertical fader component | Range input rotated 270°. dB scale markings (-60 to +6). Touch-friendly (large thumb). Sends volume change on drag via Socket.IO | UR-LCP-003 | §6.2 |
| 10.5 | VU meter (vertical) | Canvas2D vertical bar meter. Green/yellow/red zones. Stereo: two side-by-side bars. 60fps update | UR-LCP-003 | §6.2 |
| 10.6 | Mute button | Toggle. Red when muted. Sends mute command (volume=0) or unmute (restore previous volume) | UR-LCP-003 | §6.2 |
| 10.7 | Master fader | Larger fader on the right side. Controls master output volume | — | §6.2 |
| 10.8 | Module filtering | Only show modules with `lcpVisible: true` in plugin manifest. Or show all audio modules by default | UR-LCP-007 | §6.2 |
| 10.9 | Engine start/stop toggle | Large button in header. Green=running, red=stopped. Sends start/stop command to engine | — | §6.2 |
| 10.10 | Mobile-friendly | Touch-optimised: large fader thumbs (44px+), no hover states, momentum scrolling for many channels | UR-LCP-006 | §5.6 |

#### Acceptance criteria

- [ ] LCP serves on port 8081 from engine device
- [ ] Vertical faders for each audio module
- [ ] VU meters animate in real-time
- [ ] Volume changes from LCP reflect in manager UI and vice versa
- [ ] Mute buttons work
- [ ] Works on tablet in portrait and landscape

---

### Phase 11 — Profile Manager App

**Goal:** Simple app on port 8082 for configuring which manager an engine connects to.

#### Tasks

| # | Task | Details | URS | FDS |
|---|------|---------|-----|-----|
| 11.1 | Vue 3 app scaffold | Vite + Vue 3 + Pinia + Tailwind. Port 8082. Proxy `/api` to engine Fastify on port 3001. Same dark theme | — | §7.3 |
| 11.2 | Profile list | Show all saved manager connection profiles. Each: name, host:port, ACTIVE badge. Calls `GET /api/v1/profiles` | UR-API-010 | §7.3 |
| 11.3 | Create profile form | Fields: name, manager host, manager port, password, optional second path (for bonding). Calls `POST /api/v1/profiles` | UR-API-011 | §7.3 |
| 11.4 | Edit profile | Pre-fill form with existing values. Calls `PUT /api/v1/profiles/:name` | UR-API-013 | §7.3 |
| 11.5 | Delete profile | Confirmation dialog. Can't delete active. Calls `DELETE /api/v1/profiles/:name` | UR-API-014 | §7.3 |
| 11.6 | Activate profile | Calls `POST /api/v1/profiles/:name/activate`. Engine restarts dgram-comms connection | UR-API-015 | §7.3 |
| 11.7 | Connection status | Green/red indicator showing if engine is currently connected to a manager | — | — |

#### Acceptance criteria

- [ ] Profile Manager serves on port 8082
- [ ] Profile CRUD works
- [ ] Activating a profile causes engine to connect to that manager
- [ ] Connection status visible

---

### Phase 12 — Video Modules & Advanced Features

**Goal:** Video encoding/decoding, raw video routing, focus mode, live-updatable config UI improvements.

#### Tasks

| # | Task | Details | URS | FDS |
|---|------|---------|-----|-----|
| **Video** | | | | |
| 12.1 | VideoEncoder plugin | video/raw + optional audio → MPEG-TS. Codecs: H.264 (software: x264enc, HW: v4l2h264enc), H.265, MPEG2. Config: codec, bitrate, framerate, keyframe interval. V4L2 source option for camera input | UR-ENG-012 | §3.3.2 |
| 12.2 | VideoDecoder plugin | MPEG-TS → video/raw + audio/pcm. Auto-detect codec. Split demuxed streams | UR-ENG-013 | §3.3.2 |
| 12.3 | VideoPlayer plugin | video/raw → display. `autovideosink` or `kmssink` for direct output. Config: display device | UR-ENG-014a | §3.3.2 |
| 12.4 | HW codec detection | Detect RPi 4 (v4l2h264enc), RPi 5 (v4l2h265enc), x86 (vaapih264enc). Report capabilities to manager. Plugin manifests include architecture tags | UR-ENG-009 | §3.3.2 |
| 12.5 | Raw video routing | FIFO-based video/raw routing in MediaRouter. Split support (one source → multiple sinks) | UR-ENG-019b | §3.2.4 |
| **Focus Mode** | | | | |
| 12.6 | Focus mode toggle | Button in routing editor toolbar. Persisted in localStorage. When on: unfocused items muted, focused items full colour | UR-UI-040 | §5.3.4 |
| 12.7 | Module focus state | Right-click → Toggle Focus. Visual: unfocused = grey background, grey text, grey VU. Focused = full colour | UR-UI-041 | §5.3.4 |
| 12.8 | Device focus state | On engine dashboard: unfocused engines muted, sorted to bottom | UR-UI-041a | §5.3.4 |
| 12.9 | Focus persistence | Store focus state in manager SQLite. Shared across browser sessions | UR-UI-042 | §5.3.4 |
| 12.10 | Link opacity | Both endpoints focused = 100%, one = 50%, neither = 20% | — | §5.3.4 |
| **Live Config** | | | | |
| 12.11 | `getLiveUpdatableParams()` | Engine sends list at startup + when it changes. Manager forwards to browser | UR-MGR-006a | §9.3 |
| 12.12 | Pending restart badge | When non-live param changes: module shows amber "restart" badge. Restart clears it | UR-MGR-006d | §5.3.3 |
| 12.13 | Mixed update flow | Settings panel sends changes. Live params apply immediately. Non-live params queue. Module shows pending restart | UR-MGR-006c | §9.3 |
| **External** | | | | |
| 12.14 | MediaMTX integration | Config for external MediaMTX process. SRT→WebRTC bridge | UR-ENG-022 | §3.4.3 |

#### Acceptance criteria

- [ ] Video encoded from V4L2 camera, sent over SRT, decoded and displayed
- [ ] Hardware codecs used when available on RPi 4/5
- [ ] Focus mode toggles visual state of modules and links
- [ ] Focus state persists in database across sessions
- [ ] Live params update without restart, non-live show pending badge

---

### Phase 13 — Security & Authentication

**Goal:** No unauthenticated access to manager. RBAC enforced. Inputs sanitised.

#### Tasks

| # | Task | Details | URS | FDS |
|---|------|---------|-----|-----|
| 13.1 | Users table | SQLite: id, username, password_hash (bcrypt cost 12), role (admin/editor/operator/viewer), engine_permissions (JSON) | UR-SEC-001 | §10.1.1 |
| 13.2 | Login page | Vue component: username + password form. Calls `POST /api/v1/auth/login`. Returns session token (HttpOnly cookie or JWT) | UR-SEC-001 | §10.1.1 |
| 13.3 | Session middleware | Express middleware validates session on every request (REST + Socket.IO handshake). Redirect to /login if invalid | UR-SEC-001 | §10.1.1 |
| 13.4 | Rate limiting | 5 failed login attempts per IP per 15 minutes. Returns 429 with retry-after | UR-SEC-001 | §10.1.1 |
| 13.5 | RBAC roles | Admin: everything. Editor: modify engines/profiles/modules. Operator: start/stop, change volumes. Viewer: read-only | UR-SEC-010 | §10.2 |
| 13.6 | Per-engine permissions | Admin assigns per-user per-engine: `control` (start/stop/volume) or `edit` (full config) or `none` | UR-SEC-014 | §10.2 |
| 13.7 | Server enforcement | Check permissions before executing Socket.IO events and REST endpoints. Return 403 on violation | UR-SEC-016 | §10.2 |
| 13.8 | UI gating | Hide/disable actions the user can't perform. Viewer sees read-only routing editor. Operator sees volume controls only | — | §10.2 |
| 13.9 | User management | Admin settings page: list users, create/edit/delete, assign roles and engine permissions | UR-SEC-013 | §10.2 |
| 13.10 | Local API auth | Loopback (127.0.0.1) bypass — no auth needed. Remote: require token from config file | UR-API-009 | §10.1.2 |
| 13.11 | Input sanitisation | Audit all user inputs. SQL: parameterised queries (already via better-sqlite3). XSS: Vue auto-escaping. JSON Schema validation on config payloads | — | §10.3 |
| 13.12 | Security tests | Test: unauthenticated access blocked, wrong role blocked, rate limiting works, SQL injection fails | UR-TST-005 | §12.2 |

#### Acceptance criteria

- [ ] Login required to access manager UI
- [ ] Viewer can see but not modify
- [ ] Operator can control assigned engines only
- [ ] Admin can manage users and all engines
- [ ] 5 failed logins → 15-min lockout
- [ ] Local API accessible without auth from localhost

---

### Phase 14 — Observability & Logging

**Goal:** Structured logging, Prometheus metrics, health monitoring.

#### Tasks

| # | Task | Details | URS | FDS |
|---|------|---------|-----|-----|
| 14.1 | Structured logging (engine) | pino with JSON output. Fields: timestamp, level, module (plugin name), message, context. Log to stdout + file | UR-OBS-001 | §11.1 |
| 14.2 | Structured logging (manager) | Same pino format. Log all Socket.IO events, REST requests, engine connections | UR-OBS-003 | §11.1 |
| 14.3 | Log rotation | pino-roll or pino-rotating-file-stream. Max 10MB per file, keep 7 days | UR-OBS-002 | §11.1 |
| 14.4 | Log API | `GET /api/v1/logs?level=error&module=srt-input&since=2026-03-16T00:00:00Z&limit=100`. Parse log files, filter, return JSON array | — | §11.1 |
| 14.5 | Health endpoints | Engine: `GET /health` → `{ status, uptime, moduleCount, memoryUsage, cpuUsage }`. Manager: `GET /health` → `{ status, uptime, engineCount, connectedBrowsers }` | UR-OBS-004 | §11.2 |
| 14.6 | Prometheus endpoint | Manager: `GET /metrics`. Expose: engine count, online engines, total modules, per-engine CPU/memory, SRT/RIST stream stats (bitrate, loss, RTT) as Prometheus gauges | UR-OBS-005 | §11.3 |
| 14.7 | Stream stats UI | Module settings panel or dedicated tab: show SRT/RIST stats in real-time (bitrate chart, RTT, loss %) | UR-OBS-006 | §11.3 |

#### Acceptance criteria

- [ ] JSON logs written to file with rotation
- [ ] `/health` returns meaningful status on both engine and manager
- [ ] Prometheus scrapes `/metrics` successfully
- [ ] SRT stats visible in manager UI
- [ ] Logs queryable via API

---

### Phase 15 — Hardening & Deployment

**Goal:** Production-ready. Stable for 72h+. Packaged. Documented.

#### Tasks

| # | Task | Details | URS | FDS |
|---|------|---------|-----|-----|
| **Stability** | | | | |
| 15.1 | 72h soak test | Run on Raspberry Pi with realistic workload (4 SRT streams, 2 HLS, audio mixing). Monitor: RSS memory, FD count, CPU. Log any crashes | UR-REL-003 | §11.4 |
| 15.2 | Memory leak testing | Heap snapshots at 0h, 12h, 24h, 48h, 72h. Compare retained objects. Test native modules specifically | UR-REL-003 | §11.4 |
| 15.3 | FD leak monitoring | Track `/proc/<pid>/fd` count. Alert if growing. Test: repeated module start/stop cycles (1000x) | — | §11.4 |
| 15.4 | Orphan detection | After engine stop: verify zero child processes. After module crash+restart cycle: verify no leaked PIDs | — | §3.6.7 |
| 15.5 | Reconnection testing | Kill manager → engine reconnects. Kill network → both reconnect. Kill engine → manager shows offline. Rapid connect/disconnect cycles (100x) | UR-COM-007 | §3.7 |
| **Packaging** | | | | |
| 15.6 | Debian package — engine | `.deb` with: compiled JS, node_modules, systemd service, default config, install script. `dpkg -i media-router-engine.deb` just works | UR-DEP-001 | §13.1 |
| 15.7 | Debian package — manager | `.deb` with: compiled JS, built manager-ui, node_modules, systemd service | UR-DEP-001 | §13.1 |
| 15.8 | systemd services | `media-router-engine.service`, `media-router-manager.service`. `Restart=always`, `RestartSec=5`, `WatchdogSec=60`. Environment file for config | UR-DEP-003 | §13.1 |
| 15.9 | Docker Compose | `docker-compose.yml` with: manager, engine, mediamtx. Shared network. Volume mounts for config and database | UR-DEP-002 | §13.2 |
| 15.10 | Bootstrap script | `install-dependencies.sh` — detect platform (RPi4/5/x86), install: Node.js 20, GStreamer, PipeWire, build-essential. Verify installation | — | §13.2 |
| **Platform testing** | | | | |
| 15.11 | RPi 4 (arm64) | Full test: audio routing, SRT, HLS, HW H.264 encode | UR-DEP-004 | §13.1 |
| 15.12 | RPi 5 (arm64) | Full test: audio routing, SRT, HLS, HW H.265 encode | UR-DEP-004 | §13.1 |
| 15.13 | x86_64 | Full test: audio routing, SRT, HLS, VAAPI encode | UR-DEP-004 | §13.1 |
| **Documentation** | | | | |
| 15.14 | Architecture documentation | System overview diagram, component responsibilities, data flow | UR-DOC-001 | — |
| 15.15 | Plugin development guide | Step-by-step: create plugin, define manifest, implement PluginModule, test, deploy | UR-DOC-001 | — |
| 15.16 | API reference | Auto-generated from Fastify OpenAPI spec | UR-DOC-001 | §7.8 |
| 15.17 | Migration guide (v1→v2) | Config conversion steps, feature mapping, breaking changes | UR-DEP-005 | — |
| **Testing** | | | | |
| 15.18 | E2E tests (Playwright) | Manager UI: register engine, add modules, create connections, switch profiles | UR-TST-007 | §12.3 |
| 15.19 | Unit test coverage audit | Fill remaining test stubs. Target ≥80% coverage across all packages | UR-TST-003 | §12.2 |

#### Acceptance criteria

- [ ] 72h soak test passes — no memory leaks, no orphan processes, no crashes
- [ ] `.deb` packages install and auto-start via systemd
- [ ] Docker Compose brings up full stack
- [ ] All 3 target platforms tested and working
- [ ] Plugin developer guide written and tested by a second person
- [ ] E2E tests pass
- [ ] Unit test coverage ≥80%

---

## 4. Dependency Graph

```
Phase 0 ──▶ Phase 1 ──▶ Phase 2 ──▶ Phase 3 ──▶ Phase 4
(Setup)     (Comms)     (Engine)    (GStreamer)  (Manager)
                                        │
                           ┌────────────┼────────────┐
                           ▼            ▼            ▼
                      Phase 5      Phase 6      Phase 7
                      (Audio)      (SRT/RIST)   (HLS/Probe)
                           │            │            │
                           └──────┬─────┘            │
                                  ▼                  │
                             Phase 8 ◄───────────────┘
                           (Audio Proc)
                                  │
                         ┌────────┼────────────┐
                         ▼        ▼            ▼
                    Phase 9   Phase 10    Phase 11
                    (Web UI)  (LCP)       (ProfMgr)
                         │
               ┌─────────┼──────────┐
               ▼         ▼          ▼
          Phase 12   Phase 13   Phase 14
          (Video)    (Security)  (Logging)
               │         │          │
               └─────────┼──────────┘
                         ▼
                    Phase 15
                  (Hardening)
```

**Parallelisation:**
- Phase 4 (Audio) must come before Phase 5 (Manager) so audio routing is testable
- Phase 6 (Manager UI) follows immediately after Phase 5 (Manager Core)
- Phases 7, 8 (protocol + processing plugins) can run in parallel after Phase 6
- Phases 10, 11 are independent of each other
- Phases 12, 13, 14 can partially overlap

---

## 5. v1.0 Feature Parity Checkpoint

At the end of **Phase 9**, all v1.0 features must be replaced:

| v1.0 Feature | v2.0 Replacement | Phase |
|--------------|-------------------|-------|
| Audio routing (PulseAudio) | PipeWire audio/pcm routing | 4 |
| SRT input/output/relay | SrtInput + SrtOutput plugins | 7 |
| RIST input/output | RistInput + RistOutput plugins | 7 |
| HLS player | HlsPlayer plugin (+ fMP4 support) | 8 |
| Audio mixer (N-1) | AudioMixer plugin | 9 |
| Sound processor | SoundProcessor plugin | 9 |
| Sound ducking | SoundDucking plugin | 9 |
| Manager web UI | Vue.js + Vue Flow | 6 |
| Local control panel | Vue.js LCP with faders | 10 |
| Profile manager | Profile Manager app | 11 |
| dgram-comms (v1) | dgram-comms v2 (multi-path) | 1 |
| Configuration management | SQLite config store + profiles | 4 |

**NOT carried forward:**
- WebRTC built-in → external MediaMTX (Phase 12)
- SrtRelay module → SrtInput→SrtOutput link
- PulseAudio loopback → PipeWire native linking
- modular-ui / modular-dm → Vue.js / TypeScript

---

## 6. Risk Register

| Risk | Impact | Phase | Mitigation |
|------|--------|-------|------------|
| GStreamer child process IPC complexity | Blocks all media | 3 | Test with `videotestsrc`/`audiotestsrc` first. Get IPC working before building real plugins |
| PipeWire API instability on Bookworm | Blocks audio routing | 5 | Pin version. Test `pw-link` early. Fallback: PulseAudio compat mode |
| GStreamer codec availability on arm64 | Missing encoders/decoders | 5, 6 | Use software codecs initially. Add HW acceleration later (Phase 12) |
| Vue Flow reactivity issues | Nodes don't update | 9 | Use `setNodes()`/`setEdges()` imperatively, never pass as props. Watch only ID changes, not deep |
| Vue Flow context menu API | Right-click doesn't work | 9 | Use `@node-context-menu` event on VueFlow component, not composable |
| fMP4 transmux edge cases | HLS fails for some sources | 7 | Test with Apple reference streams, Akamai, Cloudflare |
| Long-running memory leaks | System degrades | 15 | Run overnight soak tests from Phase 6 onwards, not just Phase 15 |
| Socket.IO reconnection floods | Browser overload | 9 | Exponential backoff, max 30s delay |
| Large SQLite config | Slow queries | 4 | WAL mode, index on engine_id, keep config blobs small |

---

## 7. Lessons Learned (from previous attempt)

These issues caused the first implementation to be scrapped. **Each must be explicitly addressed in the relevant phase:**

| Issue | Root Cause | Fix | Phase |
|-------|-----------|-----|-------|
| Modules don't appear on canvas | Vue Flow ignores `:nodes` prop changes after initial render | Use `setNodes()` from `useVueFlow()` composable, never pass nodes as prop | 9 |
| Modules jump when clicking handles | `watch` with `deep: true` calls `setNodes()` on every property change | Only watch module ID list (sorted string), not deep properties | 9 |
| Connections don't appear | `applyPatchOperation` didn't handle JSON Patch `-` (array append) | Handle `last === '-' && Array.isArray(target)` → `push()` | 9 |
| Right-click menu doesn't work | Used `onNodeContextMenu` composable (doesn't exist in v1.48) | Use `@node-context-menu` event on `<VueFlow>` component | 9 |
| Settings panel empty | Module state didn't include `configSchema` from plugin manifest | Store ports + configSchema in module config when adding | 4 |
| Module nodes too wide/long | No port data → no handles rendered → node collapsed | Include ports in module state from plugin manifest | 4 |
| Server crash on module add | `INSERT INTO` on existing profile (PK constraint) | Use `INSERT OR IGNORE` | 4 |
| Modules lost on page reload | `engine:list` didn't include modules from active profile config | Load profile config and include modules/connections in engine:list | 4 |
| Side panels scroll with canvas | Used `position: absolute` instead of `position: fixed` | Use `fixed` positioning for all overlay panels | 9 |
| Browser zooms instead of canvas | Ctrl+wheel not intercepted | Add non-passive wheel listener, `preventDefault()` on Ctrl+wheel | 9 |

---

*End of Document*
