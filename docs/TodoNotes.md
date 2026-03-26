# TODO Notes 

## General 
[x] - Latency grows over time from 50 ms to 200 ms over time (fixed: pulsesink slave-method=0 + processing-deadline/buffer-time/max-lateness from v1)
[x] - Tool tip for rightclick menu / small description for each function (native title tooltips on all node + edge context menu items)
[x] - Module settings displayable in the right click menu via x-contextMenu in package.json (volume slider with throttled live updates)
[x] - revamp manager file (1071 → 105 lines, extracted into 6 handler files)
[x] - add reset button, that kills the service and restarts pipewire service (Reset button in routing toolbar: stops modules → restarts PipeWire → cleans orphans → restarts modules)
[x] - revamp media-router file (518 → 225 lines, extracted PortRegistry + ConnectionExecutor)
[x] - Plugins should be able to spawn their own services (ProcessManager: ManagedProcess + ownership tracking, auto-cleanup on module stop, auto-restart with backoff)
[x] - Revamp engine.ts (668 → 230 lines, extracted CommandDispatcher + ModuleLifecycle + SystemStatsCollector)
[x] - Logging does not log per plugin, but only as core functions (fixed: per-instance logger as Plugin:<instanceId>)
[x] - Engine stop start is not reliable, some times i stop the engine, and when i want to start again, the engine doesn ot receive te command, so i need to try muiltiple time to get it going
[x] - Unit tests: 212 tests across 21 files, all passing
[x] - Write Readme on the project, how to setup, dependancies, how to install etc (README.md + DEPENDENCIES.md)
[x] - When i move a module so i start to drag and hold the modue a while, it jumps back to the starting position (fixed: 3s drag lock prevents server position overwrite)
[x] - Add mute / unmute setting on Plugins with audio / should be able to mute their null sink / thier source / dest
[x] - With modules that play audio into a null sink (like audio decoder / Audio output) the vumeter is mesuerd before the null sink, so if the user drops the volume on that module, the vu meter does not reflect the volume change, event though the voloume change is applied directly. (consider spawning seperate process for vu menter?)
[x] - issue, when adding a moduel can get it started, until i stop and start the engine, then only i can get it started 
[ ] - !!!!!! Issue that orpahne process stil lrun, so my audio outpu hsa audio on it, even though there in not connection to it, i need to stop and start the engine to fix this, this only hapeps ocationaly (Might have been with the deleted modules that does not get stopped, but need to test)
[x] - module being addid far of from the other modules (fixed: new modules placed at center of current viewport)
[ ] - tace and warn debugging 
[x] - When moving modules, the modules jump back to the original position if i do not keep moving the mouse (fixed: track active drags via dragStart/dragStop, block server position updates during entire drag + 2s after)
[x] - Some times i need to refresh the page, if i was away from it for a while to see live data again, as if the socket conenction does not auto reconnect or smt (fixed: re-emit watch:engine on Socket.IO reconnect so VU/logs resume)
[x] - when clicking outside the stats page, the page does not close (fixed: click handler moved to backdrop overlay)
[x] - When i enable a module, i need to restart it before it stats up, it does not auto start
[x] - Mute control has a debounce, so when i mute i have to wait a while before i can unmute, this is a issue and should not be like that (fixed: optimistic local store update on toggle, no round-trip delay)
[x] - When module does not receive audio anymore, the vu meter displays the last vu meter data instead of going back to 0 (-60db) (fixed: VU store auto-resets to zero after 600ms of no updates)

## Srt & Rist 
[x] test rist 
[x] fix srt stats
[ ] latency test srt & rits 
[x] Muilticonenction rist 
[x] issue, when adding a moduel can get it started, until i stop and start the engine, then only i can get it started 
[x] [object Object] on rist link, not user friendy at all 
[x] srt uses same icons as encoders 
[x] conenction indicator - for srt and rist 
[x] convert Bytes Received to easy readable stats
[x] Audio decoder after rist input does some times stops after a while (fixed: decoder now has restartOnError: true — auto-restarts pipeline on tsdemux error/EOS + fixed undefined vars in RIST input parseStats)
[x] - Rist modules does not have a conenction badge (fixed: RIST input shows peer count badge, RIST output shows Connected/No link badge)
[ ] - SRT and rist latnecy is still growing. (to be tested now)

## Featrues 
[ ] - Mpegts combiner and splitter module (this modules should be able to recive muiltiple mpegts streams, and combine it into a sigle stream, and the spliter the opiste, the user should be able to configure how many streams he wants, or it need to auto detect how many streams is conencted? )
[x] - Seed db with dummy data on first start (manager: 'local' engine with Audio Input → Audio Output profile; engine: 'local' profile connecting to 127.0.0.1:3000)

## LCP
[x] - Modules width should be fixed 
[x] - Sort order should be small to large  (not large to small)
[x] - Bigger slider knobs in the LCP (44px thumb, 48px interaction width, touch-friendly)
[x] - Tablet landscape/portrait support (responsive layout, compact landscape mode, safe area insets for notched devices)

## Audio issues 
[x] - On my yocto devices i am not able to start audio inputs, see logs for erros 
