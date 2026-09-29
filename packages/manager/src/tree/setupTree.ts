import * as fs from 'fs';
import * as path from 'path';
import { TREE_PROTOCOL } from '@media-router/shared-types';
import { attachTree, type TopicBus } from '@media-router/topic-tree';
import type { Server as SocketIOServer } from 'socket.io';
import type { TreeWrites } from './TreeWrites.js';
import type { TreeCalls } from './TreeCalls.js';

const UI_INDEX = path.resolve(__dirname, '../../../manager-ui/dist/index.html');

/** Changes whenever a new UI bundle is deployed; open tabs reload on it. */
export function uiBuildId(indexPath = UI_INDEX): string {
    try {
        const st = fs.statSync(indexPath);
        return `${Math.round(st.mtimeMs)}-${st.size}`;
    } catch {
        return 'dev';
    }
}

export interface TreeSetupDeps {
    io: SocketIOServer;
    bus: TopicBus;
    writes: TreeWrites;
    calls: TreeCalls;
}

/** The manager's only browser protocol (ADR-0024). */
export function setupTree({ io, bus, writes, calls }: TreeSetupDeps): void {
    attachTree(io, {
        bus,
        hello: () => ({ proto: TREE_PROTOCOL, build: uiBuildId() }),
        onWrite: (caller, ops, writeId) => writes.handle(caller, ops, writeId),
        onCall: (caller, p, method, args) => calls.handle(caller, p, method, args),
    });
}
