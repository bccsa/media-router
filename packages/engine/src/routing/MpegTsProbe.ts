import { execFile } from 'node:child_process';
import { createLogger } from '@media-router/shared-types';

const log = createLogger('MpegTsProbe');

export interface ProbeResult {
    codec: 'opus' | 'aac' | 'mp2' | 'ac3' | 'unknown';
    sampleRate?: number;
    channels?: number;
    rawCaps: string;
}

/**
 * Probes an MPEG-TS UDP multicast stream to detect the audio codec.
 *
 * Runs a short gst-launch pipeline with `-v` flag and parses the negotiated
 * caps from tsdemux to identify the codec type.
 *
 * @param host Multicast group address
 * @param port UDP port
 * @param timeoutMs Max time to wait for detection (default 3000ms)
 */
export function probeMpegTsStream(
    host: string,
    port: number,
    timeoutMs = 3000,
): Promise<ProbeResult> {
    return new Promise((resolve) => {
        const args = [
            '-v',
            'udpsrc', `multicast-group=${host}`, `port=${port}`,
            'multicast-iface=lo', 'auto-multicast=true', 'num-buffers=50',
            '!', 'tsdemux', 'latency=0',
            '!', 'fakesink',
        ];

        log.info({ host, port }, 'Probing MPEG-TS stream');

        const child = execFile('gst-launch-1.0', args, {
            timeout: timeoutMs,
            maxBuffer: 1024 * 64,
        }, (err, stdout, stderr) => {
            const output = (stdout ?? '') + (stderr ?? '');
            const capsMatch = output.match(/caps\s*=\s*(audio\/[^\n]+)/);

            if (!capsMatch) {
                log.warn({ host, port }, 'No audio caps detected');
                resolve({ codec: 'unknown', rawCaps: '' });
                return;
            }

            const rawCaps = capsMatch[1].trim();
            const result = parseCaps(rawCaps);
            log.info({ host, port, codec: result.codec, rawCaps }, 'Detected codec');
            resolve(result);
        });

        // Safety: kill if still running after timeout
        setTimeout(() => {
            try { child.kill('SIGTERM'); } catch {}
        }, timeoutMs + 500);
    });
}

function parseCaps(rawCaps: string): ProbeResult {
    // Extract sample rate and channels if present
    const rateMatch = rawCaps.match(/rate=\(int\)(\d+)/);
    const chMatch = rawCaps.match(/channels=\(int\)(\d+)/);
    const sampleRate = rateMatch ? parseInt(rateMatch[1], 10) : undefined;
    const channels = chMatch ? parseInt(chMatch[1], 10) : undefined;

    if (rawCaps.startsWith('audio/x-opus')) {
        return { codec: 'opus', sampleRate, channels, rawCaps };
    }

    if (rawCaps.startsWith('audio/mpeg')) {
        const versionMatch = rawCaps.match(/mpegversion=\(int\)(\d+)/);
        const version = versionMatch ? parseInt(versionMatch[1], 10) : 0;

        if (version === 4) {
            return { codec: 'aac', sampleRate, channels, rawCaps };
        }
        if (version === 1) {
            return { codec: 'mp2', sampleRate, channels, rawCaps };
        }
    }

    if (rawCaps.startsWith('audio/x-ac3')) {
        return { codec: 'ac3', sampleRate, channels, rawCaps };
    }

    return { codec: 'unknown', sampleRate, channels, rawCaps };
}

