# TODO Notes 

[TESTING] - Latency grows over time from 50 ms to 200 ms over time.
[x] - Tool tip for rightclick menu / small description for each function (native title tooltips on all node + edge context menu items)
[ ] - Module settings displayable in the right click menu, by sepecifying it in the package.json that it shoould display there
[x] - revamp manager file (1071 → 105 lines, extracted into 6 handler files)
[x] - add reset button, that kills the service and restarts pipewire service (Reset button in routing toolbar: stops modules → restarts PipeWire → cleans orphans → restarts modules)
[x] - revamp media-router file (518 → 225 lines, extracted PortRegistry + ConnectionExecutor)
[x] - Plugins should be able to spawn their own services (ProcessManager: ManagedProcess + ownership tracking, auto-cleanup on module stop, auto-restart with backoff)
[x] - Revamp engine.ts (668 → 230 lines, extracted CommandDispatcher + ModuleLifecycle + SystemStatsCollector)
[x] - Logging does not log per plugin, but only as core functions (fixed: per-instance logger as Plugin:<instanceId>)
[x] - Engine stop start is not reliable, some times i stop the engine, and when i want to start again, the engine doesn ot receive te command, so i need to try muiltiple time to get it going
[x] - Unit tests: 134 tests across 14 files, all passing. Coverage: dgram-comms 92%, engine/modules 55%, engine/plugins 29%, engine/routing 35%, engine/comms 22%, engine/api (new), manager/config 63%, manager/handlers (new). Remaining: audio (PipeWire-dependent), UI packages (needs Vue Test Utils)
[x] - Write Readme on the project, how to setup, dependancies, how to install etc (README.md + DEPENDENCIES.md)