# ADR-0012: The GStreamer runner is orchestrated inside the engine process; only the python pipeline runner is a child

Each module's pipeline runs in its own python `gst-pipeline-runner.py` child,
as before. The TypeScript that orchestrates that child — `GstRunner`: the
pipeline state machine, the restart loop, the socket gate, the command/event
translation — runs **inside the engine process**, hosted by
`InProcessRunnerHost`. There is no longer a forked `gst-runner.js` node
process per module. The fork is kept as a rollback only, behind
`MR_GST_RUNNER_FORK=1`, for one release.

## Why

Measured on a 2 GB Pi 4 (10.9.16.108, node 20.19, GStreamer 1.28.2,
2026-09-03), every module cost two processes:

| Process | RSS | PSS |
|---|---|---|
| node `gst-runner.js` shim | 60 MB | 28 MB |
| python `gst-pipeline-runner.py` | 64–88 MB | 47–70 MB |

A bare `node -e ""` on that box is 51 MB RSS: the shim was a whole node
runtime carrying 1,600 lines of state machine. On a 1.5 GB Pi running 15
modules (10.9.16.105) the shims alone were ~255 MB PSS and the box sat at
110 MB available. A 16-module 302M profile (ZA-SCC-FRA01) did not fit a 2 GB
Pi at all.

The shim existed for the original stdin/stdout MPEG-TS data-pipe mode (a
module's media relayed through the shim's stdio) and for isolating the
orchestration JavaScript from the engine. The data-pipe mode has no callers —
every module carries media on the unixfd bus — and the isolation was
accidental: neither the shim nor the engine installs an exception handler,
and nothing in the shim ever ran GStreamer.

## What is, and is not, isolated

- **GStreamer stays isolated.** A segfault, a kernel decoder wedge, an OOM
  kill or a runaway pipeline still takes down one module's python and nothing
  else; the same `GstRunner` restart loop rebuilds it.
- **The orchestration JavaScript is not.** A throw in `GstRunner` /
  `PythonProcess` / `InProcessRunnerHost` would now be a throw in the engine.
  So the runner never touches `process` — it reaches the world only through
  its `RunnerHost` seam (`post` + `exit`), pinned by `eosDrainContract.test.ts`
  — and every entry into it is a fault boundary: a request that throws rejects
  that one request, a Python event or a module-side event handler that throws
  is logged and dropped.
- **Engine exit reaps every python.** One `process.on('exit')` hook in
  `InProcessRunnerHost` SIGKILLs the python of every runner still live, the job
  each shim's own exit hook used to do; python also drains and exits by itself
  when its command pipe closes.

## Consequences

- `GstChildProcess` keeps its public surface; plugins are untouched. Its
  `pid` is now the module's python (the process a module owns), not a shim.
- The teardown drain contract is unchanged: `stop()` sends `stopPipeline`,
  calls `shutdown` (the nudge the fork got as SIGTERM) and waits up to
  `GST_RUNNER_KILL_TIMEOUT_MS` for the runner to hand itself back, then
  SIGKILLs the python — the shim's kill window, without the shim.
- `shutdown` bumps the start epoch itself: under the fork the process exit
  ended an in-flight socket-gate wait, in-process nothing else would.
- A python that exits **cleanly** outside a teardown is restarted like any
  other unexpected exit (the gate01 wedge of 2026-07-18: a replacement python
  exiting 0 used to read as an intentional stop and stranded every downstream
  consumer). Only the two terminal paths make an exit intentional.
- `runnerEnv()` is the one place the runner env is built (Wayland seeding,
  `MALLOC_ARENA_MAX=2` unless set): the python inherited it through the shim
  before, now it is applied at the python spawn.
- `useStdioForData` is refused in-process with a `spawn_failed` error naming
  the rollback flag; it would otherwise wire the ENGINE's stdio into a
  pipeline.
- Rollback: `Environment=MR_GST_RUNNER_FORK=1` on the engine unit restores the
  fork per module. Remove the fork path, `gst-runner.ts` and `ControlIpc` once
  a release has soaked without it.

## References

- `packages/engine/src/child-process/InProcessRunnerHost.ts` — the host (the default `RunnerBackend`).
- `packages/engine/src/child-process/ForkedRunnerBackend.ts` — the rollback backend, slated for deletion.
- `packages/engine/src/child-process/GstRunner.ts` — `RunnerHost`; `runnerHandback.ts` — the one-shot hand-back.
- `packages/engine/src/child-process/GstChildProcess.ts` — backend selection, `stop()`.
- `packages/engine/src/child-process/runnerEnv.ts` — the runner env, with the allocator measurement.
- [[0010]] — the socket gate whose wait `shutdown` must now cancel itself.
