import { createLogger } from '@media-router/shared-types';
import type { Connection, ActiveHandle } from './MediaRouter.js';
import type { StreamTypeExecutorRegistry } from './StreamTypeExecutor.js';

const log = createLogger('ConnectionExecutor');

/**
 * Dispatcher that routes connection execute / teardown calls through the
 * `StreamTypeExecutorRegistry`. The two built-in executors (PCM audio over
 * pw-link, MPEG-TS over UDP multicast) are registered by the engine during
 * `Engine.start()`. Plugins can add more via `services.streamExecutors`.
 *
 * Per-stream-type implementation logic lives in:
 *   - `PcmAudioExecutor` (`audio/pcm`)
 *   - `MpegTsBusExecutor` (`muxed/mpegts`)
 */
export class ConnectionExecutor {
    constructor(private registry: StreamTypeExecutorRegistry) {}

    async execute(conn: Connection): Promise<ActiveHandle | null> {
        const executor = this.registry.forStreamType(conn.streamType);
        if (!executor) {
            log.warn(
                { streamType: conn.streamType, known: this.registry.streamTypes() },
                'Unknown stream type — no executor registered',
            );
            return null;
        }
        return executor.execute(conn);
    }

    async teardown(
        handle: ActiveHandle,
        conn: Connection | undefined,
        skipModuleRestart = false,
    ): Promise<void> {
        const executor = this.registry.forHandle(handle);
        if (!executor) {
            log.warn(
                { handleType: handle.type, connectionId: handle.connectionId },
                'No executor registered for handle type — skipping teardown',
            );
            return;
        }
        await executor.teardown(handle, conn, skipModuleRestart);
    }
}
