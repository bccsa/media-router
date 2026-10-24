import pino from 'pino';
import { Transform } from 'stream';
import { redactSecrets, redactValue } from './redact.js';

/**
 * Global log tap — when set, receives a copy of every log JSON line
 * produced by any logger created via createLogger().
 */
let globalLogTap: ((line: string) => void) | null = null;

export function setLogTap(tap: ((line: string) => void) | null): void {
    globalLogTap = tap;
}

/** One JSON log line with every secret redacted (B-109); a line that is not JSON goes as text. */
function redactLine(line: string): string {
    let entry: unknown;
    try {
        entry = JSON.parse(line);
    } catch {
        return redactSecrets(line);
    }
    const clean = redactValue(entry);
    return clean === entry ? line : JSON.stringify(clean) + (line.endsWith('\n') ? '\n' : '');
}

/**
 * Create a named logger instance.
 *
 * All Media Router components use this factory so log format is consistent
 * across engine, manager, and plugins. Output is structured JSON via pino.
 *
 * If a global log tap is set (via setLogTap), every JSON log line is
 * also forwarded to the tap function; the tap and stderr get it with its secrets redacted.
 *
 * @param name  Component name (e.g. 'Engine', 'ModuleManager', 'PipeWireManager')
 */
export function createLogger(name: string): pino.Logger {
    // Create a transform stream that tees to the tap
    const tee = new Transform({
        transform(chunk, _encoding, callback) {
            const line = redactLine(chunk.toString());
            if (globalLogTap) {
                try {
                    globalLogTap(line);
                } catch {
                    /* never block */
                }
            }
            callback(null, line);
        },
    });
    tee.pipe(process.stderr);

    return pino(
        {
            name,
            // Default to 'debug' for development — set LOG_LEVEL=info for production
            level: process.env.LOG_LEVEL ?? 'debug',
            timestamp: pino.stdTimeFunctions.isoTime,
        },
        tee,
    );
}
