# TODO Notes 

[ ] - Latency grows over time from 50 ms to 200 ms over time.
[ ] - Tool tip for rightclick menu / small description for each function 
[ ] - Module settings displayable in the right click menu, by sepecifying it in the package.json that it shoould display there
[x] - revamp manager file (1071 → 105 lines, extracted into 6 handler files)
[ ] - add reset button, that kills the service and restarts pipewire service (pipewire should try, but if it does not have permission it should give error, but continue with resetting the service)
[x] - revamp media-router file (518 → 225 lines, extracted PortRegistry + ConnectionExecutor)
[ ] - Plugins should be able to spawn their own services, for example the rist plugin, will need to spwan the rist cli on order to work
[x] - Revamp engine.ts (668 → 230 lines, extracted CommandDispatcher + ModuleLifecycle + SystemStatsCollector)
[ ] - Logging does not log per plugin, but only as core functions

