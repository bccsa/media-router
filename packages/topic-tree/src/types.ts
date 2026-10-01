import type { PatchOp, TreeErrorCode, WriteResult } from '@media-router/shared-types';

/** The slice of a Socket.IO server socket the tree needs. */
export interface TreeSocket {
    id: string;
    emit(event: string, payload: unknown): unknown;
    conn: {
        transport: { writable: boolean };
    };
}

/** Read access to a server's tree; values are built on demand. */
export interface TreeSource {
    /** The value at a concrete path, or undefined. */
    get(path: readonly string[]): unknown;
    /** Child keys at a concrete path — object keys or array element ids. */
    keys(path: readonly string[]): string[];
}

/** Who sent a write or call. */
export interface TreeCaller {
    socketId: string;
}

export type WriteHandler = (
    caller: TreeCaller,
    ops: PatchOp[],
    writeId: number,
) => WriteResult | Promise<WriteResult>;

export type CallHandler = (
    caller: TreeCaller,
    path: string,
    method: string,
    args: unknown,
) => unknown | Promise<unknown>;

/** Thrown by a call handler to fail with a message the client may show; `code` for the client to act on. */
export class TreeCallError extends Error {
    constructor(
        message: string,
        readonly code?: TreeErrorCode,
    ) {
        super(message);
        this.name = 'TreeCallError';
    }
}
