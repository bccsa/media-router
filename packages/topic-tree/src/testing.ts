import { getAt, keysOf } from '@media-router/shared-types';
import type { TreeSocket, TreeSource } from './types.js';

/** In-memory socket double: records emits, lets a test stall the transport. */
export function fakeSocket(id: string) {
    const emitted: Array<[string, any]> = [];
    let writable = true;
    const socket: TreeSocket & {
        emitted: typeof emitted;
        setWritable(v: boolean): void;
        frames(): any[];
    } = {
        id,
        emitted,
        emit: (event: string, payload: unknown) => emitted.push([event, payload]),
        conn: {
            transport: {
                get writable() {
                    return writable;
                },
            },
        },
        setWritable(v: boolean) {
            writable = v;
        },
        frames() {
            return emitted.filter(([e]) => e === 'tree').map(([, p]) => p.ops);
        },
    };
    return socket;
}

/** A TreeSource over a plain object. */
export function objectSource(root: unknown): TreeSource {
    return { get: (path) => getAt(root, path), keys: (path) => keysOf(getAt(root, path)) };
}
