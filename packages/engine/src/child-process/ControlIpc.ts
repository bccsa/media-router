import * as crypto from 'crypto';
import type { ChildProcess } from 'child_process';
import type { ControlIpcMessage } from '@media-router/shared-types';

/**
 * Typed IPC layer for parent↔child process communication.
 *
 * Supports:
 * - Request/response with ID correlation and timeout
 * - Fire-and-forget events
 * - Incoming event routing by action name
 */
export class ControlIpc {
    private child: ChildProcess;
    private pending = new Map<
        string,
        {
            resolve: (data: unknown) => void;
            reject: (err: Error) => void;
            timer: ReturnType<typeof setTimeout>;
        }
    >();
    private eventHandlers = new Map<string, (data: unknown) => void>();
    private messageHandler: (msg: ControlIpcMessage) => void;
    private exitHandler: () => void;

    constructor(child: ChildProcess) {
        this.child = child;

        this.messageHandler = (msg: ControlIpcMessage) => {
            if (msg.type === 'response') {
                // Resolve pending request
                const pending = this.pending.get(msg.id);
                if (pending) {
                    clearTimeout(pending.timer);
                    this.pending.delete(msg.id);
                    pending.resolve(msg.data);
                }
            } else if (msg.type === 'event') {
                // Route to registered handler
                const handler = this.eventHandlers.get(msg.action);
                handler?.(msg.data);
            }
        };

        this.exitHandler = () => {
            // Reject all pending requests
            for (const [, pending] of this.pending) {
                clearTimeout(pending.timer);
                pending.reject(new Error('Child process exited'));
            }
            this.pending.clear();
        };

        child.on('message', this.messageHandler);
        child.on('exit', this.exitHandler);
    }

    /**
     * Send a request and wait for a response with matching ID.
     */
    sendRequest(action: string, data?: unknown, timeout = 10000): Promise<unknown> {
        return new Promise((resolve, reject) => {
            const id = crypto.randomUUID();

            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`IPC request timeout: ${action} (${timeout}ms)`));
            }, timeout);

            this.pending.set(id, { resolve, reject, timer });

            const msg: ControlIpcMessage = { id, type: 'request', action, data };
            if (!this.child.connected) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(new Error('IPC channel closed'));
                return;
            }
            this.child.send(msg);
        });
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
        for (const [, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.reject(new Error('ControlIpc destroyed'));
        }
        this.pending.clear();
        this.eventHandlers.clear();
    }
}
