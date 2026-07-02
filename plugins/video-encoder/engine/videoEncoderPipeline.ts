import { execFileSync } from 'child_process';
import { parseFormats, type CodecId, type ImplId } from '@media-router/engine';

/** Names of properties that can be live-tweaked on the resolved encoder. */
export function liveElementProps(codec: CodecId, impl: ImplId): string[] {
    if (impl === 'v4l2') return ['extra-controls'];
    return codec === 'av1' ? ['target-bitrate'] : ['bitrate'];
}

/**
 * Whether the encoder element accepts bitrate changes at runtime *cleanly*.
 *
 * - v4l2h264enc/v4l2h265enc on RPi kernels with gst-plugins-good ≥ 1.22 honour
 *   `extra-controls:video_bitrate=…` live (re-asserting CBR mode on each
 *   write — see `applyLiveBitrate`).
 * - x264enc/x265enc accept `bitrate` live, but `vbv-maxrate`/`vbv-bufsize`
 *   are baked into `option-string` at element init and cannot be updated
 *   without a pipeline rebuild. Reporting these as live-tunable would let
 *   the user push bitrate above the original VBV cap and overflow downstream
 *   buffers. We therefore route software-encoder bitrate changes through
 *   pendingRestart (caller falls back to non-live update), same as AV1.
 * - svtav1enc has to rebuild encoder state for a new `target-bitrate`.
 */
export function supportsLiveBitrate(codec: CodecId, impl: ImplId): boolean {
    return impl === 'v4l2' && codec !== 'av1';
}

/** Parse a `"<width>x<height>"` resolution string; defaults to 1920x1080 on failure. */
export function parseResolution(resolution: string): { width: number; height: number } {
    const m = resolution.match(/^(\d+)x(\d+)$/);
    if (!m) return { width: 1920, height: 1080 };
    return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
}

/**
 * Build the v4l2src source branch. USB cameras typically offer MJPG at high
 * resolutions and raw YUYV only at low framerates; HDMI capture devices
 * (Cam Link 4K, etc.) commonly only expose raw formats. We probe what the
 * device supports at the requested {width × height} and pick the cheapest
 * input caps; framerate mismatches and pixel-format conversions are bridged
 * downstream by `videorate ! videoconvert ! videoscale` so a device that
 * can't do exactly the requested fps still produces clean output.
 *
 * A leaky 100ms queue is placed immediately after v4l2src (and its format
 * filter). Without it, any back-pressure from downstream (videoconvert,
 * videoscale, encoder) blocks v4l2src and the V4L2 driver's kernel ring
 * buffer fills up — when full, frames drop at the kernel level, which the
 * GStreamer pipeline below can't see or recover from. With the queue, brief
 * downstream stalls are absorbed in user-space and frames keep being drained
 * from the kernel; only sustained back-pressure causes (visible) drops.
 */
const SOURCE_QUEUE_MS = 100;

/**
 * Common raw pixel formats reported by V4L2 devices. `videoconvert` handles
 * any of these so we don't need format-specific branches — we just need to
 * tell v4l2src which one to pick at the device side. Order encodes a
 * heuristic: semi-planar (NV12/NV16) is preferred over planar (YU12/YV12)
 * which is preferred over packed (YUYV/UYVY). Within each layout class the
 * 4:2:0 variant comes first because it's lower bandwidth than 4:2:2.
 */
const RAW_FORMAT_PREFERENCE = ['NV12', 'NV16', 'YU12', 'YV12', 'YUYV', 'UYVY'];

export function buildV4l2Source(
    device: string,
    width: number,
    height: number,
    framerate: number,
): string {
    const src = `v4l2src device=${device}`;
    const queue = `queue leaky=2 max-size-time=${SOURCE_QUEUE_MS * 1_000_000} max-size-buffers=0 max-size-bytes=0`;
    // Output side: convert pixel format → conform framerate → conform
    // resolution → declare the encoder's expected caps. `videorate` is
    // load-bearing here: HDMI capture devices (Cam Link 4K, etc.) only
    // expose specific framerates, so when the user picks a different one
    // we drop / duplicate frames here rather than failing caps negotiation.
    const tail = `videoconvert ! videorate ! videoscale ! video/x-raw,width=${width},height=${height},framerate=${framerate}/1`;
    let supported: { pixelFormat: string; framerates: number[] }[] = [];
    try {
        const stdout = execFileSync(
            'v4l2-ctl',
            ['--device', device, '--list-formats-ext'],
            { encoding: 'utf-8', timeout: 2000 },
        );
        supported = parseFormats(stdout)
            .filter((f) => f.width === width && f.height === height)
            .map((f) => ({ pixelFormat: f.pixelFormat, framerates: f.framerates }));
    } catch {
        /* probe failed — fall through to no-caps v4l2src negotiation */
    }
    // Pick the closest framerate the device actually offers for the chosen
    // pixel format. `videorate` then conforms it to `framerate` for the
    // encoder.
    const closestFps = (offered: number[]): number =>
        offered.length === 0
            ? framerate
            : offered.reduce((best, fps) =>
                  Math.abs(fps - framerate) < Math.abs(best - framerate) ? fps : best,
              );
    const mjpg = supported.find((f) => f.pixelFormat === 'MJPG');
    if (mjpg) {
        const fps = closestFps(mjpg.framerates);
        return `${src} ! image/jpeg,width=${width},height=${height},framerate=${fps}/1 ! ${queue} ! jpegdec ! ${tail}`;
    }
    const raw = RAW_FORMAT_PREFERENCE.map((p) =>
        supported.find((f) => f.pixelFormat === p),
    ).find((f) => f !== undefined);
    if (raw) {
        const fps = closestFps(raw.framerates);
        return `${src} ! video/x-raw,format=${raw.pixelFormat},width=${width},height=${height},framerate=${fps}/1 ! ${queue} ! ${tail}`;
    }
    // Probe failed or device offers nothing at this resolution — let
    // v4l2src negotiate freely and rely on the conversion tail to bridge.
    return `${src} ! ${queue} ! ${tail}`;
}
