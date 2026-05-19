import { execFile } from 'node:child_process';
import { createLogger } from '@media-router/shared-types';

const log = createLogger('MpegTsProbe');

/**
 * Probe result for an MPEG-TS audio stream.
 *
 * `codec` is a string (not a closed union) so plugins can introduce their
 * own codec identifiers via `registerCodecClassifier`. Consumers typically
 * switch on the value with a `default` branch for unknown codecs.
 */
export interface ProbeResult {
    /** Codec id from the matching classifier, or `'unknown'` if none matched. */
    codec: string;
    sampleRate?: number;
    channels?: number;
    rawCaps: string;
}

/**
 * Pluggable codec classifier for MPEG-TS caps. Registered classifiers are
 * tested in registration order; the first match wins. Engine code no longer
 * hardcodes any codec mappings — plugins (typically `mpegts-demuxer` via its
 * static `registerServices`) provide them.
 */
export interface CodecClassifier {
    /** Returns true when this classifier should handle the given caps string. */
    test(rawCaps: string): boolean;
    /** Returns the codec id to expose on `ProbeResult.codec`. */
    classify(rawCaps: string): string;
}

const classifiers: CodecClassifier[] = [];
let warnedAboutEmptyRegistry = false;

/**
 * Register a codec classifier. Safe to call from a plugin's static
 * `registerServices` (runs during engine startup, before any module starts
 * so `probeMpegTsStream` calls during module `onStart` see the classifier).
 *
 * Duplicate registrations are tolerated — later entries are tried first, so
 * a plugin can override an earlier classifier without forcing the engine
 * to dedupe.
 */
export function registerCodecClassifier(c: CodecClassifier): void {
    // Unshift so newer registrations take priority — useful when an override
    // plugin replaces a built-in classifier.
    classifiers.unshift(c);
}

/** Test-only: clear the classifier list. Not exported from the package index. */
export function _resetCodecClassifiersForTests(): void {
    classifiers.length = 0;
    warnedAboutEmptyRegistry = false;
}

/**
 * Probes an MPEG-TS UDP multicast stream to detect the audio codec.
 *
 * Runs a short `gst-launch` pipeline with `-v` and parses the negotiated
 * caps from `tsdemux`. Codec identification is delegated to the registered
 * classifiers — see `registerCodecClassifier`.
 */
export function probeMpegTsStream(
    host: string,
    port: number,
    timeoutMs = 3000,
): Promise<ProbeResult> {
    return new Promise((resolve) => {
        // Multicast (239.x) uses multicast-group, unicast (127.x) uses plain port
        const isMulticast = host.startsWith('239.');
        const udpSrcArgs = isMulticast
            ? [
                  'udpsrc',
                  `multicast-group=${host}`,
                  `port=${port}`,
                  'multicast-iface=lo',
                  'auto-multicast=true',
                  'num-buffers=50',
              ]
            : ['udpsrc', `port=${port}`, 'num-buffers=50'];
        const args = ['-v', ...udpSrcArgs, '!', 'tsdemux', 'latency=0', '!', 'fakesink'];

        log.info({ host, port }, 'Probing MPEG-TS stream');

        let resolved = false;
        const child = execFile(
            'gst-launch-1.0',
            args,
            {
                timeout: timeoutMs,
                maxBuffer: 1024 * 64,
            },
            (err, stdout, stderr) => {
                if (resolved) return;
                resolved = true;
                clearTimeout(safetyTimer);

                const output = (stdout ?? '') + (stderr ?? '');
                const capsMatch = output.match(/caps\s*=\s*(audio\/[^\n]+)/);

                if (!capsMatch) {
                    log.warn({ host, port }, 'No audio caps detected');
                    resolve({ codec: 'unknown', rawCaps: '' });
                    return;
                }

                const rawCaps = capsMatch[1].trim();
                const result = classifyCaps(rawCaps);
                log.info(
                    { host, port, codec: result.codec, channels: result.channels, rawCaps },
                    'Detected codec',
                );
                resolve(result);
            },
        );

        // Safety: kill if still running after timeout (guards against execFile timeout not firing)
        const safetyTimer = setTimeout(() => {
            if (resolved) return;
            try {
                child.kill('SIGKILL');
            } catch {
                /* already dead */
            }
        }, timeoutMs + 500);
    });
}

/**
 * Map a raw GStreamer caps string to a `ProbeResult`. Exposed so callers that
 * already have caps (e.g. live pipeline introspection) can run the same
 * classification logic `probeMpegTsStream` uses without spawning gst-launch.
 */
export function classifyCaps(rawCaps: string): ProbeResult {
    // Extract sample rate and channels generically — every well-formed
    // GStreamer audio caps string carries them, regardless of codec.
    const rateMatch = rawCaps.match(/rate=\(int\)(\d+)/);
    const chMatch = rawCaps.match(/channels=\(int\)(\d+)/);
    const sampleRate = rateMatch ? parseInt(rateMatch[1], 10) : undefined;
    const channels = chMatch ? parseInt(chMatch[1], 10) : undefined;

    // Codec identification is plugin-provided — see `registerCodecClassifier`.
    let codec = 'unknown';
    for (const c of classifiers) {
        if (c.test(rawCaps)) {
            codec = c.classify(rawCaps);
            break;
        }
    }
    if (codec === 'unknown' && classifiers.length === 0 && !warnedAboutEmptyRegistry) {
        // Latch the warning so a probe-heavy module doesn't fill the journal
        // when the host shipped without the mpegts-demuxer plugin. One log
        // per process is enough to surface the misconfiguration.
        warnedAboutEmptyRegistry = true;
        log.warn(
            { rawCaps },
            'No codec classifiers registered — install a plugin that registers them (e.g. mpegts-demuxer). This warning fires once per process.',
        );
    }
    return { codec, sampleRate, channels, rawCaps };
}
