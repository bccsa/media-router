/**
 * GStreamer child process runner — LEGACY forked entry script.
 *
 * The default engine hosts `GstRunner` in-process (`InProcessRunnerHost`);
 * this script is the `MR_GST_RUNNER_FORK=1` rollback, spawned by
 * `GstChildProcess` via `child_process.fork()`. It receives a pipeline
 * description via IPC, spawns `gst-pipeline-runner.py`, monitors it, and
 * reports state/VU/errors back to the parent.
 *
 * All orchestration lives in `GstRunner.ts`. This file is the thin shim that
 * wires Node-process signals + the `process.send` IPC channel to a single
 * runner instance. The `process.connected` / try-catch guard survives the
 * brief window during graceful shutdown where the channel is closed but late
 * Python events are still being relayed — without it those writes throw
 * `ERR_IPC_CHANNEL_CLOSED` and crash the child.
 */
import * as path from 'path';
import type { ControlIpcMessage } from '@media-router/shared-types';
import { GstRunner } from './GstRunner.js';

const runner = new GstRunner(path.resolve(__dirname, 'gst-pipeline-runner.py'), {
    post: (msg: ControlIpcMessage) => {
        if (!process.connected) return;
        try {
            process.send?.(msg);
        } catch {
            /* channel closed mid-write */
        }
    },
    exit: () => process.exit(0),
});

process.on('message', (msg: ControlIpcMessage) => runner.handleControlMessage(msg));
process.on('disconnect', () => runner.shutdown('parent disconnected'));
process.on('SIGTERM', () => runner.shutdown('SIGTERM'));
process.on('SIGINT', () => runner.shutdown('SIGINT'));

// Emergency cleanup: if this process exits for any reason, kill Python
process.on('exit', () => runner.emergencyKill());
