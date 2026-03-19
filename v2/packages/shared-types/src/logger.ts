import pino from 'pino';
import { Transform } from 'stream';

/**
 * Global log tap — when set, receives a copy of every log JSON line
 * produced by any logger created via createLogger().
 */
let globalLogTap: ((line: string) => void) | null = null;

export function setLogTap(tap: ((line: string) => void) | null): void {
    globalLogTap = tap;
}

/**
 * Create a named logger instance.
 *
 * All Media Router components use this factory so log format is consistent
 * across engine, manager, and plugins. Output is structured JSON via pino.
 *
 * If a global log tap is set (via setLogTap), every JSON log line is
 * also forwarded to the tap function.
 *
 * @param name  Component name (e.g. 'Engine', 'ModuleManager', 'PipeWireManager')
 */
export function createLogger(name: string): pino.Logger {
    // Create a transform stream that tees to the tap
    const tee = new Transform({
        transform(chunk, _encoding, callback) {
            if (globalLogTap) {
                try { globalLogTap(chunk.toString()); } catch { /* never block */ }
            }
            callback(null, chunk);
        },
    });
    tee.pipe(process.stderr);

    return pino(
        {
            name,
            level: process.env.LOG_LEVEL ?? 'info',
            timestamp: pino.stdTimeFunctions.isoTime,
        },
        tee,
    );
}
