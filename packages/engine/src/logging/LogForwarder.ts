import { EventEmitter } from 'events';
import { setLogTap } from '@media-router/shared-types';

export interface LogEntry {
    level: number;
    time: string;
    name: string;
    msg: string;
    moduleId?: string;
    [key: string]: unknown;
}

/**
 * Collects pino log entries from all engine loggers and forwards
 * them to the manager connection in batches.
 *
 * Emits:
 *   - 'logs' (LogEntry[]) — batch of log entries ready to send
 */
export class LogForwarder extends EventEmitter {
    private buffer: LogEntry[] = [];
    private flushTimer: ReturnType<typeof setInterval> | null = null;
    private maxBufferSize: number;

    constructor(maxBufferSize = 50) {
        super();
        this.maxBufferSize = maxBufferSize;

        // Tap into all pino loggers
        setLogTap((line: string) => this.onLine(line));

        // Flush every 500ms
        this.flushTimer = setInterval(() => this.flush(), 500);
    }

    private onLine(line: string): void {
        try {
            const entry = JSON.parse(line) as LogEntry;
            this.buffer.push(entry);

            if (this.buffer.length >= this.maxBufferSize) {
                this.flush();
            }
        } catch {
            // Ignore malformed lines
        }
    }

    private flush(): void {
        if (this.buffer.length === 0) return;
        const batch = this.buffer;
        this.buffer = [];
        this.emit('logs', batch);
    }

    destroy(): void {
        setLogTap(null);
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = null;
        }
        this.flush();
        this.removeAllListeners();
    }
}
