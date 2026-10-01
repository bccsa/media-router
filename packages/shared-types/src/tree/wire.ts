import type { PatchOp } from '../index.js';

// Tree protocol constants and message types, free of zod: a browser client
// (the router's dashboard viewer, ADR-0026) imports only this.

/** Bumped on any breaking change to the tree protocol (ADR-0024). */
export const TREE_PROTOCOL = 1;

/** Why a server refused a client on another protocol version; parsed back by `requiredProtocol`. */
export function protocolMismatch(sent: unknown): string {
    return `tree protocol ${TREE_PROTOCOL} required, client sent ${String(sent)}`;
}

/** The protocol a refusal names, or null for any other connect error. */
export function requiredProtocol(message: string): number | null {
    const m = /^tree protocol (\d+) required/.exec(message);
    return m ? Number(m[1]) : null;
}

/** Socket.IO event names of the tree protocol. */
export const TREE_EVENTS = {
    sub: 'sub',
    unsub: 'unsub',
    write: 'write',
    call: 'call',
    frame: 'tree',
    hello: 'hello',
    renamed: 'tree:renamed',
} as const;

/** Branches a router serves at `/` (ADR-0024). */
export const ROUTER_BRANCHES = ['info', 'system', 'devices', 'logs', 'modules', 'connections', 'interlocks', 'dashboards'];
/** Branches of `/engines/<id>` on the manager: a router's, plus its profiles. */
export const ENGINE_BRANCHES = [...ROUTER_BRANCHES, 'profiles'];

/** Socket.IO path of a router's tree endpoint on :8081. */
export const ROUTER_TREE_PATH = '/tree';

/** A delta op; `w` marks the echo of the receiving client's own write. */
export type TreeOp = PatchOp & { w?: number };

export interface TreeFrame {
    ops: TreeOp[];
}

export interface TreeHello {
    proto: number;
    /** Changes whenever the served UI bundle changes. */
    build: string;
}

export interface WriteRejection {
    index: number;
    path: string;
    reason: string;
}

export interface WriteResult {
    rejected: WriteRejection[];
}

export interface TreeRenamed {
    from: string;
    to: string;
}

/** Why a call failed, for a client to act on (the message is for people). */
export type TreeErrorCode = 'conflict' | 'needs-confirm';

export type TreeAck<T> = { ok: true; data: T } | { ok: false; error: string; code?: TreeErrorCode };
