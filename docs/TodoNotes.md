# TODO Notes

## General
- [x] Latency grows over time from 50 ms to 200 ms over time (fixed: pulsesink slave-method=0 + processing-deadline/buffer-time/max-lateness from v1)
- [x] Tool tip for rightclick menu / small description for each function (native title tooltips on all node + edge context menu items)
- [x] Module settings displayable in the right click menu via x-contextMenu in package.json (volume slider with throttled live updates)
- [x] revamp manager file (1071 → 105 lines, extracted into 6 handler files)
- [x] add reset button, that kills the service and restarts pipewire service (Reset button in routing toolbar: stops modules → restarts PipeWire → cleans orphans → restarts modules)
- [x] revamp media-router file (518 → 225 lines, extracted PortRegistry + ConnectionExecutor)
- [x] Plugins should be able to spawn their own services (ProcessManager: ManagedProcess + ownership tracking, auto-cleanup on module stop, auto-restart with backoff)
- [x] Revamp engine.ts (668 → 230 lines, extracted CommandDispatcher + ModuleLifecycle + SystemStatsCollector)
- [x] Logging does not log per plugin, but only as core functions (fixed: per-instance logger as Plugin:<instanceId>)
- [x] Engine stop start is not reliable, some times i stop the engine, and when i want to start again, the engine doesn ot receive te command, so i need to try muiltiple time to get it going
- [x] Unit tests: 212 tests across 21 files, all passing
- [x] Write Readme on the project, how to setup, dependancies, how to install etc (README.md + DEPENDENCIES.md)
- [x] When i move a module so i start to drag and hold the modue a while, it jumps back to the starting position (fixed: 3s drag lock prevents server position overwrite)
- [x] Add mute / unmute setting on Plugins with audio / should be able to mute their null sink / thier source / dest
- [x] With modules that play audio into a null sink (like audio decoder / Audio output) the vumeter is mesuerd before the null sink, so if the user drops the volume on that module, the vu meter does not reflect the volume change, event though the voloume change is applied directly. (consider spawning seperate process for vu menter?)
- [x] issue, when adding a moduel can get it started, until i stop and start the engine, then only i can get it started
- [ ] !!!!!! Issue that orpahne process stil lrun, so my audio outpu hsa audio on it, even though there in not connection to it, i need to stop and start the engine to fix this, this only hapeps ocationaly (Might have been with the deleted modules that does not get stopped, but need to test)
- [x] module being addid far of from the other modules (fixed: new modules placed at center of current viewport)
- [x] tace and warn debugging (log viewer has per-level toggles for Debug/Info/Warn/Error; silent failures throughout the codebase now log at debug/warn level with context)
- [x] When moving modules, the modules jump back to the original position if i do not keep moving the mouse (fixed: track active drags via dragStart/dragStop, block server position updates during entire drag + 2s after)
- [x] Some times i need to refresh the page, if i was away from it for a while to see live data again, as if the socket conenction does not auto reconnect or smt (fixed: re-emit watch:engine on Socket.IO reconnect so VU/logs resume)
- [x] when clicking outside the stats page, the page does not close (fixed: click handler moved to backdrop overlay)
- [x] When i enable a module, i need to restart it before it stats up, it does not auto start
- [x] Mute control has a debounce, so when i mute i have to wait a while before i can unmute, this is a issue and should not be like that (fixed: optimistic local store update on toggle, no round-trip delay)
- [x] When module does not receive audio anymore, the vu meter displays the last vu meter data instead of going back to 0 (-60db) (fixed: VU store auto-resets to zero after 600ms of no updates)

## Srt & Rist
- [x] test rist
- [x] fix srt stats
- [ ] latency test srt & rits
- [x] Muilticonenction rist
- [x] issue, when adding a moduel can get it started, until i stop and start the engine, then only i can get it started
- [x] [object Object] on rist link, not user friendy at all
- [x] srt uses same icons as encoders
- [x] conenction indicator - for srt and rist
- [x] convert Bytes Received to easy readable stats
- [x] Audio decoder after rist input does some times stops after a while (fixed: decoder now has restartOnError: true — auto-restarts pipeline on tsdemux error/EOS + fixed undefined vars in RIST input parseStats)
- [x] Rist modules does not have a conenction badge (fixed: RIST input shows peer count badge, RIST output shows Connected/No link badge)
- [ ] SRT and rist latnecy is still growing. (to be tested now)

## Featrues
- [ ] Mpegts combiner and splitter module (this modules should be able to recive muiltiple mpegts streams, and combine it into a sigle stream, and the spliter the opiste, the user should be able to configure how many streams he wants, or it need to auto detect how many streams is conencted? )
- [x] Seed db with dummy data on first start (manager: 'local' engine with Audio Input → Audio Output profile; engine: 'local' profile connecting to 127.0.0.1:3000)

## LCP
- [x] Modules width should be fixed
- [x] Sort order should be small to large (not large to small)
- [x] Bigger slider knobs in the LCP (44px thumb, 48px interaction width, touch-friendly)
- [x] Tablet landscape/portrait support (responsive layout, compact landscape mode, safe area insets for notched devices)
- [x] Change to tailwind css (added @theme inline mapping CSS vars to Tailwind tokens; converted 262 :style bindings across 28 files to utility classes)
- [x] Knobs and mute button is some times hard to press on the touch screen devices, can we make the touch area bigger? (fixed: mute button min-height 48px + larger padding/font, fader track widened from 48px to 64px)

## Audio issues
- [x] On my yocto devices i am not able to start audio inputs, see logs for erros
- [x] opus has some kind of noice gate build in, see how to disable (fixed: dtx=false disables silence detection/gating, inband-fec=true adds error correction)
- [x] Make inband-fec configurable in encoder settings — adds ~5-10% bitrate overhead, could matter with many streams over constrained links (Should aslos add % option as a configurable) (added inbandFec toggle + packetLoss % dropdown, both opus-only via x-showWhen, live-updatable)

## Manager-ui
- [x] Manager ui does not currectly reflect engine online status, the engine can be offline but the manager-ui still shows it online, until i refresh (Not even refresh woeks, they manager indication stays online even though it is offline)
- [x] Cant remove labels on links (fixed: send empty string instead of undefined)
- [x] settins does not live update between rightclick menu and setting pane, if i make the change in the one, i first need to close and open the other ot see the change (fixed: removed localSettings snapshot guard, panel now watches store deeply and always syncs)
- [x] Manager not showing (most) links anymore (fixed: added moduleIds to edge watcher dependencies + skip connections with missing modules)
- [x] Module config panel overlaps with the top bar, hiding connected status and light/dark mode button. Popups should tuck under the top bar (fixed: both settings and add-module panels now start at top-12, below the header)
- [x] Add module menu doesn't show when a module settings menu is open — perhaps show it to the left of the module settings menu? (fixed: clicking Add Module now closes the settings panel)
- [x] Light mode too light — make the sheet background colour darker so modules stand out against the background (fixed: darkened bg-primary to #f8fafc, bg-secondary to #e9edf2, bg-sidebar to #e2e8f0 — white cards now stand out)
- [x] Rename search field to "Search modules…"
- [x] N-1 Mixer naming unclear in menu — rename to "N-1 Audio Mixer"
- [x] New module not visible until browser refresh after adding via manager
- [ ] Screen goes black after changing browser URL to background1 and back

## Engine
- [x] When the engine reconnects to the manager, it restarts, instead of keeping its running state
- [x] Need to stop and start the engine, after the engine restarted (fixed: moduleManager.size > 0 reports actual running state)
- [x] Add a spawnd process counter, that can be displayed in the manager top bar
- [x] Resetting automatically starts engine even when in stopped state — to recreate: stop engine → press reset (fixed: resetEngine checks wasRunning + stopRequested flag aborts restart if stop arrives during reset)
- [x] Engine shows stopped (start button showing) but modules are still running (state sync issue)
- [x] PWLink delete is buggy — creating and deleting a PWLink leaves it in the engine; incorrect links reappear until stop/start (fixed: PatchRouter was sending ID-based paths to engine instead of index-based — engine couldn't resolve _connId. Also added 3-step teardown cleanup: unlink by name → unlink by ID → pwUnlinkAllBetween sweep)
- [ ] Disconnected Audio encoder shows signal after deleting default audio input and switching output to HDMI — persists after restart
- [ ] N-1 mixer stopped giving output after reboot
- [ ] "Source channel out of range" errors and "Failed to reapply connection" when connecting to Test 1 enc
- [ ] High RAM usage on Pi — 1.5GB available; index.js, start-engine.js, and Pipewire consuming significant memory; Python vs C++ contributing

## Data Flow revamp
- [x] when i move a module, after 2 seconds, it jumps back to original position (fixed: optimistic local store update on drag end)
- [x] when i click stop / start on the lcp it has no effect (fixed: re-added control event listener)
- [x] Stop start state does not sync to the lcp (works — just takes a moment for modules to start)
- [x] Name does not live update between manager-ui and lcp (fixed: LCP applyPatch now handles all module fields)
- [x] LCP controls in modules does not live update between manager-ui and lcp (this should follow the same patch path.)
- [x] ALL Config should follow the same patch flow (verified: all config changes use patch, only lifecycle commands remain as direct events)
- [x] When i change a module name, it does not reflect on the module on the same page (fixed: optimistic local store update on rename)
- [x] When module settings pane is open and switching to new module, name stays on old module (fixed: reset editName on moduleId change)
- [x] Channel map changes is not live anymore, need to restart for changes to take effect (fixed: same root cause as pw-link delete — PatchRouter sent ID-based paths to engine. Also: EnginePatchRouter now handles both add/replace ops for channelMap, added fallback _connId resolution)
- [x] Channel map does not rightly detect channel count from the decoder, decoder can have 6 channels, but channel map only sees 2 (fixed: decoder reads channels from connected encoder, creates null-sink with correct count, exposes as readOnly setting)
- [x] Need to refresh tab after module is added (fixed: optimistic addModule now includes ports, configSchema, color, icon, default settings, health — so the node renders immediately without waiting for server enrichment)

## Device / System (from alpha testing)
- [ ] Splash image not showing when connecting a monitor
- [x] Debug logging toggle reversed (fixed: log level buttons are now per-level toggles instead of thresholds — click each level to show/hide independently. Default enables Info/Warn/Error; Trace/Debug off)

## Feature Requests (from alpha testing)
- [x] Enable mDNS to easily discover the media router
- [x] Show RAUC download progress when selecting a new image, and display message that restart is needed

- [x] Output channel count still not detected correctly in the channel map on links (fixed: decoder now always probes the stream before creating null-sink — detects channels from actual MPEG-TS caps regardless of source. Encoder also normalizes config values so downstream readers always see explicit values) 

- [x] LCP Light mode can't see module names (fixed: `.module-name` in MixerStrip.vue had hardcoded `color: #ffffff` — changed to `var(--text-primary)` so it follows light/dark theme)
- [x] Engine online / offline indication is not live (fixed: setOnline/setRunning now create new EngineState objects instead of mutating in-place — Vue's computed caching missed the in-place mutation. Also: clearEngineRuntime resets module health/stats/badges on disconnect)
- [x] USB audio hotplug: new devices not detected until engine reset (fixed: engine polls `pactl` every 2s and pushes to manager when device list changes; settings panel polls manager every 3s while open. Worst case ~5s latency from hotplug to UI update)
- [x] Device persistence on disconnect: if a selected audio device is unplugged, keep it in the dropdown (fixed: `deviceOptions()` in ModuleSettingsPanel appends the currently-selected device with "(Disconnected)" suffix if it's not in the current device list. Removed only when user selects a different device)

- [x] Change LCP from mute / unmute to on (highlighted) / off (greyed out)
- [x] Issue with n-1 data channels between engine and mannager, so the issue is as follows: 
    I have the interlocks setup, and it works well, but when i on the lcp unmute a channel in an interlock group, the change happesn correctly on the manager-ui, but in the lcp, the mute update command does not come through (even after refresh) so it shows that both channels is unmuted, even though one of them is muted
    (fixed: manager now forwards cascade ops back to the engine when the engine was the sender, so LCP clients see the sibling mutes)

- [x] Make on / off buttons square
- [x] clone does not work for live chagne, when i clone, i need to refresh before i see the cloned item (fixed: `applyEnginePatch` now runs `normalizeModule` on optimistic `/modules/<id>` adds so freshly cloned nodes have the full `ModuleState` shape — without it `pendingRestart`/`focused`/`interlock`/etc. stayed undefined and the node didn't render until `engine:config` rehydrated after refresh)