/**
 * GStreamer child process runner — entry script.
 *
 * Spawned by the engine via `child_process.fork()`. Receives a pipeline
 * string via IPC, spawns `gst-pipeline-runner.py`, monitors it, and reports
 * state/VU/errors back to the parent.
 *
 * All orchestration lives in `GstRunner.ts`. This file is the thin shim
 * that wires Node-process signals + IPC to a single runner instance.
 */
import * as path from 'path';
import type { ControlIpcMessage } from '@media-router/shared-types';
import { GstRunner } from './GstRunner.js';

const runner = new GstRunner(path.resolve(__dirname, 'gst-pipeline-runner.py'));

process.on('message', (msg: ControlIpcMessage) => runner.handleControlMessage(msg));
process.on('disconnect', () => runner.shutdown('parent disconnected'));
process.on('SIGTERM', () => runner.shutdown('SIGTERM'));
process.on('SIGINT', () => runner.shutdown('SIGINT'));
// Emergency cleanup: if this process exits for any reason, kill Python
process.on('exit', () => runner.emergencyKill());
