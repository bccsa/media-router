import {
    CallRequestSchema,
    PatternListSchema,
    TREE_EVENTS,
    TREE_PROTOCOL,
    protocolMismatch,
    WriteRequestSchema,
    createLogger,
    type TreeAck,
    type TreeHello,
} from '@media-router/shared-types';
import type { TopicBus } from './TopicBus.js';
import { TreeCallError, type CallHandler, type TreeSocket, type WriteHandler } from './types.js';

const log = createLogger('TreeServer');

interface IoSocketLike extends TreeSocket {
    handshake: { auth?: Record<string, unknown> };
    on(event: string, listener: (...args: any[]) => void): unknown;
}

interface IoLike {
    use(fn: (socket: IoSocketLike, next: (err?: Error) => void) => void): unknown;
    on(event: 'connection', listener: (socket: IoSocketLike) => void): unknown;
}

export interface TreeServerOptions {
    bus: TopicBus;
    hello: () => TreeHello;
    onWrite: WriteHandler;
    onCall: CallHandler;
}

function parse<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, raw: unknown): T {
    const r = schema.safeParse(raw);
    if (!r.success) throw new TreeCallError('invalid request');
    return r.data;
}

async function reply(ack: unknown, event: string, fn: () => unknown): Promise<void> {
    const cb = typeof ack === 'function' ? (ack as (a: TreeAck<unknown>) => void) : () => {};
    try {
        cb({ ok: true, data: await fn() });
    } catch (err) {
        if (err instanceof TreeCallError) {
            cb({ ok: false, error: err.message });
            return;
        }
        log.error({ err, event }, 'tree handler threw');
        cb({ ok: false, error: 'internal error' });
    }
}

/**
 * Serve the tree protocol on a Socket.IO server: refuse clients on another
 * protocol version, greet with `hello`, route sub/unsub/write/call.
 */
export function attachTree(io: IoLike, opts: TreeServerOptions): void {
    io.use((socket, next) => {
        const proto = socket.handshake.auth?.proto;
        if (proto === TREE_PROTOCOL) next();
        else next(new Error(protocolMismatch(proto)));
    });

    io.on('connection', (socket) => {
        const { bus } = opts;
        bus.attach(socket);
        socket.emit(TREE_EVENTS.hello, opts.hello());

        socket.on(TREE_EVENTS.sub, (raw: unknown, ack: unknown) =>
            reply(ack, 'sub', () => ({ ops: bus.subscribe(socket.id, parse(PatternListSchema, raw).patterns) })),
        );
        socket.on(TREE_EVENTS.unsub, (raw: unknown, ack: unknown) =>
            reply(ack, 'unsub', () => {
                bus.unsubscribe(socket.id, parse(PatternListSchema, raw).patterns);
                return {};
            }),
        );
        socket.on(TREE_EVENTS.write, (raw: unknown, ack: unknown) =>
            reply(ack, 'write', async () => {
                const { id, ops } = parse(WriteRequestSchema, raw);
                const result = await opts.onWrite({ socketId: socket.id }, ops, id);
                for (const r of result.rejected) bus.echo(socket.id, r.path, id);
                return result;
            }),
        );
        socket.on(TREE_EVENTS.call, (raw: unknown, ack: unknown) =>
            reply(ack, 'call', () => {
                const { path, method, args } = parse(CallRequestSchema, raw);
                return opts.onCall({ socketId: socket.id }, path, method, args);
            }),
        );
        socket.on('disconnect', () => bus.detach(socket.id));
    });
}
