import { execFileSync } from 'child_process';
import { parseFormats } from './v4l2Devices.js';

export type CodecId = 'h264' | 'h265' | 'av1';
export type ImplId = 'v4l2' | 'software';

/** GStreamer element name for each {codec × impl} combination. */
export const ENCODER_ELEMENTS: Record<CodecId, Partial<Record<ImplId, string>>> = {
    h264: { v4l2: 'v4l2h264enc', software: 'x264enc' },
    h265: { v4l2: 'v4l2h265enc', software: 'x265enc' },
    av1: { software: 'svtav1enc' }, // Pi 5 has no HW AV1
};

/**
 * Resolve the actual impl to use at runtime. Consults the runtime probe
 * results (passed in) so `auto` picks an impl that's actually installed
 * rather than one that just appears in the static element table. Returns
 * `null` when no impl is available — caller should fail the pipeline build.
 */
export function resolveImpl(
    codec: CodecId,
    preference: ImplId | 'auto',
    available: ImplId[],
): ImplId | null {
    if (available.length === 0) return null;
    if (preference === 'auto') {
        return available.includes('v4l2') ? 'v4l2' : available[0];
    }
    if (available.includes(preference)) return preference;
    return available[0];
}

export function buildEncoderBranch(
    codec: CodecId,
    impl: ImplId,
    bitrateKbps: number,
    kif: number,
): string {
    const bps = bitrateKbps * 1000;
    if (impl === 'v4l2') {
        if (codec === 'h264') {
            return `v4l2h264enc name=venc0 extra-controls="controls,video_bitrate=${bps},h264_i_frame_period=${kif}" ! video/x-h264,level=(string)4 ! h264parse config-interval=1`;
        }
        if (codec === 'h265') {
            return `v4l2h265enc name=venc0 extra-controls="controls,video_bitrate=${bps},h265_i_frame_period=${kif}" ! h265parse config-interval=1`;
        }
    }
    if (impl === 'software') {
        if (codec === 'h264') {
            return `x264enc name=venc0 tune=zerolatency bitrate=${bitrateKbps} speed-preset=superfast key-int-max=${kif} bframes=0 ! h264parse config-interval=1`;
        }
        if (codec === 'h265') {
            return `x265enc name=venc0 bitrate=${bitrateKbps} tune=zerolatency speed-preset=superfast key-int-max=${kif} ! h265parse config-interval=1`;
        }
        if (codec === 'av1') {
            return `svtav1enc name=venc0 target-bitrate=${bitrateKbps} preset=10 ! av1parse`;
        }
    }
    throw new Error(`Unsupported codec/impl combination: ${codec}/${impl}`);
}

/** Names of properties that can be live-tweaked on the resolved encoder. */
export function liveElementProps(codec: CodecId, impl: ImplId): string[] {
    if (impl === 'v4l2') return ['extra-controls'];
    return codec === 'av1' ? ['target-bitrate'] : ['bitrate'];
}

/**
 * Whether the encoder element accepts bitrate changes at runtime.
 * x264enc/x265enc honour `bitrate` live (takes effect on the next keyframe);
 * v4l2h264enc/v4l2h265enc on RPi kernels with gst-plugins-good ≥ 1.22 honour
 * `extra-controls:video_bitrate=…` live. svtav1enc does NOT — it has to
 * rebuild state for a new `target-bitrate`, so those changes route through
 * pendingRestart.
 */
export function supportsLiveBitrate(codec: CodecId): boolean {
    return codec !== 'av1';
}

/** Parse a `"<width>x<height>"` resolution string; defaults to 1920x1080 on failure. */
export function parseResolution(resolution: string): { width: number; height: number } {
    const m = resolution.match(/^(\d+)x(\d+)$/);
    if (!m) return { width: 1920, height: 1080 };
    return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
}

/**
 * Build the v4l2src source branch. USB cameras typically offer MJPG at high
 * resolutions and raw YUYV only at low framerates, so we probe what the
 * device supports at the requested {width × height × framerate} and pick the
 * right input caps. Falls back to raw if probing fails.
 */
export function buildV4l2Source(
    device: string,
    width: number,
    height: number,
    framerate: number,
): string {
    const common = `v4l2src device=${device}`;
    try {
        const stdout = execFileSync(
            'v4l2-ctl',
            ['--device', device, '--list-formats-ext'],
            { encoding: 'utf-8', timeout: 2000 },
        );
        const formats = parseFormats(stdout);
        const supports = (pixelFormat: string) =>
            formats.some(
                (f) =>
                    f.pixelFormat === pixelFormat &&
                    f.width === width &&
                    f.height === height &&
                    (f.framerates.length === 0 || f.framerates.includes(framerate)),
            );
        if (supports('MJPG')) {
            return `${common} ! image/jpeg,width=${width},height=${height},framerate=${framerate}/1 ! jpegdec ! videoconvert ! videoscale`;
        }
        if (supports('YUYV') || supports('YU12') || supports('NV12')) {
            return `${common} ! video/x-raw,width=${width},height=${height},framerate=${framerate}/1 ! videoconvert ! videoscale`;
        }
    } catch {
        /* fall through to raw path */
    }
    return `${common} ! videoconvert ! videoscale ! video/x-raw,width=${width},height=${height},framerate=${framerate}/1`;
}
