import * as crypto from 'crypto';
import type { ChildProcess } from 'child_process';
import type { ControlIpcMessage } from '@media-router/shared-types';
import { PendingRequests } from './pendingRequests.js';

/**
 * What `GstChildProcess` needs from whatever carries its control traffic to a
 * `GstRunner`: request/response with ID correlation and timeout, fire-and-
 * forget events, and incoming event routing by action name. Two carriers:
 * `InProcessRunnerHost` (the runner lives in this process — the default) and
 * `ControlIpc` below (the runner lives in a forked `gst-runner.js`, kept as
 * the `MR_GST_RUNNER_FORK=1` rollback).
 */
export interface RunnerChannel {
    sendRequest(action: string, data?: unknown, timeout?: number): Promise<unknown>;
    sendEvent(action: string, data?: unknown): void;
    on(action: string, handler: (data: unknown) => void): void;
    off(action: string): void;
    destroy(): void;
}

/**
 * Typed IPC layer for parent↔child process communication (the forked-runner
 * carrier of `RunnerChannel`).
 */
export class ControlIpc implements RunnerChannel {
    private child: ChildProcess;
    private readonly pending = new PendingRequests('IPC');
    private eventHandlers = new Map<string, (data: unknown) => void>();
    private messageHandler: (msg: ControlIpcMessage) => void;
    private exitHandler: () => void;

    constructor(child: ChildProcess) {
        this.child = child;

        this.messageHandler = (msg: ControlIpcMessage) => {
            if (msg.type === 'response') {
                this.pending.resolve(msg.id, msg.data);
            } else if (msg.type === 'event') {
                // Route to registered handler
                const handler = this.eventHandlers.get(msg.action);
                handler?.(msg.data);
            }
        };

        this.exitHandler = () => {
            this.pending.rejectAll(new Error('Child process exited'));
        };

        child.on('message', this.messageHandler);
        child.on('exit', this.exitHandler);
    }

    /**
     * Send a request and wait for a response with matching ID.
     */
    sendRequest(action: string, data?: unknown, timeout = 10000): Promise<unknown> {
        const id = crypto.randomUUID();
        const result = this.pending.open(id, action, timeout);
        if (!this.child.connected) {
            this.pending.reject(id, new Error('IPC channel closed'));
            return result;
        }
        const msg: ControlIpcMessage = { id, type: 'request', action, data };
        this.child.send(msg);
        return result;
    }

    /**
     * Send a fire-and-forget event to the child.
     */
    sendEvent(action: string, data?: unknown): void {
        if (!this.child.connected) return;
        const msg: ControlIpcMessage = {
            id: crypto.randomUUID(),
            type: 'event',
            action,
            data,
        };
        this.child.send(msg);
    }

    /**
     * Register a handler for incoming events from the child.
     */
    on(action: string, handler: (data: unknown) => void): void {
        this.eventHandlers.set(action, handler);
    }

    /**
     * Remove an event handler.
     */
    off(action: string): void {
        this.eventHandlers.delete(action);
    }

    /**
     * Clean up pending requests and remove child process listeners.
     */
    destroy(): void {
        this.child.removeListener('message', this.messageHandler);
        this.child.removeListener('exit', this.exitHandler);
        this.pending.rejectAll(new Error('ControlIpc destroyed'));
        this.eventHandlers.clear();
    }
}
