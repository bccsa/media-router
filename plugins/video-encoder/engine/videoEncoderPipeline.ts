import { execFileSync } from 'child_process';
import { buildScaleStage, parseFormats, type CodecId, type ImplId } from '@media-router/engine';
import { pickCaptureMode, type CaptureMode } from './captureModes.js';

/**
 * The capture tail's software scale/convert. The default (tests, non-Pi
 * hosts), and ALSO what a hardware host gets when the chosen capture mode
 * already has the requested size: `videoscale`/`videoconvert` go basetransform
 * passthrough at near-zero cost when caps match, whereas the Pi 4 ISP
 * (`v4l2convert`) round-trips every frame regardless and caps at ~46 fps at
 * 1080p (measured, see the video-player's scaling note) — a 1080p50 capture
 * encoded at 1080p must not go through it for nothing.
 */
function softwareScaleStage(width: number, height: number): string {
    return buildScaleStage({ width, height, impl: 'software', threads: 2 });
}

export { pickCaptureMode, type CaptureMode } from './captureModes.js';

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

/**
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
 * Assemble the source branch for an already-probed device. Split out of
 * `buildV4l2Source` (which shells out to `v4l2-ctl`) so the whole
 * mode-selection + caps-assembly path is pure and testable.
 *
 * `modes` is `undefined` when the probe itself failed — that, and only that,
 * plus "device offers no format we can name", drops to bare negotiation.
 */
export function buildV4l2SourceForModes(
    device: string,
    width: number,
    height: number,
    framerate: number,
    modes: CaptureMode[] | undefined,
    scaleStage: string = softwareScaleStage(width, height),
): string {
    // `do-timestamp=true` (v1 parity): stamp each captured buffer with the
    // pipeline clock at capture time instead of trusting driver timestamps.
    // Under `liveCaptureClock` the pipeline runs on the contract's house clock
    // with a natural base-time, so these stamps are what the mux schedules on —
    // UVC driver timestamps have their own epoch and jitter.
    const src = `v4l2src device=${device} do-timestamp=true`;
    const queue = `queue leaky=2 max-size-time=${SOURCE_QUEUE_MS * 1_000_000} max-size-buffers=0 max-size-bytes=0`;
    // Output side: its own THREAD (the bounded leaky queue), then scale →
    // convert → conform framerate → declare the encoder's expected caps.
    //
    // The queue splits decode from scale/convert/encode. Without it the whole
    // path shares one thread, and 1080p jpegdec (~40 ms/frame on a Pi4) plus
    // the rest is over a 25 fps frame budget — the source-side leaky queue then
    // sheds most frames (measured 2026-09-01: 2 real fps out of a clean 25).
    // Buffers-bounded and small on purpose: these are decoder-pool frames (see
    // the same rule on `buildEncodeLeaf`'s decoder-pool queue).
    //
    // `videorate` FIRST: it conforms the framerate for devices that can't hit
    // the requested fps, and every frame it drops is one the scale stage never
    // touches. It is `drop-only` — it must never DUPLICATE. Duplicating turns
    // any transient overload into a death spiral — one shed frame leaves a PTS
    // gap, videorate fills it with ~a dozen dups, the dups eat the very thread
    // budget whose exhaustion caused the shed, and real throughput pins at
    // ~2 fps (measured 2026-09-01). Dropping conforms a too-fast device; a
    // too-slow device just delivers its real rate, which every consumer of
    // this live stream handles. The scale stage LAST, directly before the
    // encoder: `buildScaleStage` — v4l2convert (Pi 4 ISP) or vapostproc when
    // the encoder impl's hardware scaler is installed (its VA-memory caps must
    // touch the encoder), else threaded videoscale ! videoconvert.
    const mode = modes ? pickCaptureMode(modes, width, height) : undefined;
    // No scaling to do (rung 1, exact size) → the software stage, which is a
    // passthrough here; the caller's hardware stage is only worth its ISP
    // round-trip when the frame actually changes size (see softwareScaleStage).
    const stage =
        mode && mode.width === width && mode.height === height
            ? softwareScaleStage(width, height)
            : scaleStage;
    const tail =
        `queue leaky=2 max-size-buffers=4 max-size-time=0 max-size-bytes=0 ! ` +
        `videorate drop-only=true ! video/x-raw,framerate=${framerate}/1 ! ${stage}`;
    if (!mode) {
        // Probe failed or the device names nothing we can pin — let v4l2src
        // negotiate freely and rely on the conversion tail to bridge.
        return `${src} ! ${queue} ! ${tail}`;
    }
    // Pick the closest framerate the device actually offers for the chosen
    // mode. `videorate` then conforms it to `framerate` for the encoder.
    const closest =
        mode.framerates.length === 0
            ? framerate
            : mode.framerates.reduce((best, f) =>
                  Math.abs(f - framerate) < Math.abs(best - framerate) ? f : best,
              );
    // MJPG rung, LATENCY: capture at the HIGHEST rate the mode offers (>= the
    // request) and drop compressed frames down to the request straight off the
    // source. Each MJPG buffer is an independent picture, so dropping is safe
    // and free, and capturing at 50 fps instead of 25 shaves ~40 ms of
    // glass-to-glass latency: the frame the encoder gets is up to one 25 fps
    // interval fresher, and jpegparse (which closes a frame only on the NEXT
    // SOI) waits 20 ms instead of 40 for its close. Decode still runs at the
    // REQUESTED rate — the drop happens before jpegdec.
    const fastest = mode.framerates.filter((f) => f > framerate);
    const captureFps =
        mode.pixelFormat === 'MJPG' && fastest.length > 0 ? Math.min(...fastest) : closest;
    const preDrop =
        captureFps > framerate
            ? ` ! videorate drop-only=true ! image/jpeg,framerate=${framerate}/1`
            : '';
    // Caps are the CHOSEN mode's, not the request's — on rung 2 they differ
    // and the tail's scale stage does the conforming.
    if (mode.pixelFormat === 'MJPG') {
        // `jpegparse` re-frames the stream on the actual JPEG markers instead
        // of trusting the driver's buffer boundaries. Load-bearing for the ATEM
        // Mini Pro: it can latch into a state where every UVC frame arrives
        // circularly rotated (the SOI header lands 64 bytes from the buffer's
        // END — one USB payload late), and bare jpegdec then fails every frame
        // with "Not a JPEG: starts with 0x05" until the camera is power-cycled.
        // Field 2026-09-01: the state survived driver rebind, USB re-enumeration
        // and a full Pi reboot; jpegparse decoded the same live stream with zero
        // errors. On a healthy stream it is a passthrough.
        // SOFTWARE jpegdec, unconditionally — there is deliberately no
        // hardware-decode switch. The bcm2835 block (v4l2jpegdec) decodes this
        // stream at full rate in isolation (behind jpegparse) but wedges before
        // PLAYING inside the running engine, re-wedges on every start once
        // poisoned, and survives driver reloads — with enumeration blackout,
        // WirePlumber's V4L2 monitor disabled and audio off it STILL wedged
        // (2026-09-02). A seam that probed it and ignored the answer was
        // removed; re-add one only together with the kernel-level fix.
        return `${src} ! image/jpeg,width=${mode.width},height=${mode.height},framerate=${captureFps}/1${preDrop} ! ${queue} ! jpegparse ! jpegdec ! ${tail}`;
    }
    return `${src} ! video/x-raw,format=${mode.pixelFormat},width=${mode.width},height=${mode.height},framerate=${captureFps}/1 ! ${queue} ! ${tail}`;
}

/**
 * Build the v4l2src source branch. USB cameras typically offer MJPG at high
 * resolutions and raw YUYV only at low framerates; HDMI capture devices
 * (Cam Link 4K, etc.) commonly only expose raw formats. We probe what the
 * device supports and pin the cheapest input caps it actually offers;
 * framerate mismatches, pixel-format conversions and resolution mismatches
 * are all bridged downstream by `videoconvert ! videorate ! videoscale`.
 *
 * Fallback ladder, in order:
 *  1. A probed mode at exactly the requested {width × height} — MJPG first
 *     (compressed, so USB bandwidth doesn't cap the framerate), then
 *     RAW_FORMAT_PREFERENCE.
 *  2. No mode at that resolution → the closest probed resolution in the
 *     preferred format (see `pickCaptureMode`), pinned verbatim — including
 *     `jpegdec` when it's MJPG — with the tail scaling to the request. This
 *     rung exists because of the Blackmagic ATEM Mini Pro: it offers ONLY
 *     MJPG 1920x1080. Configured at 1280x720 the old code found no matching
 *     mode, fell through to bare negotiation and handed `image/jpeg` straight
 *     into `videoconvert` with no decoder — the pipeline died "not-negotiated"
 *     on a Pi4 in the field. Now it captures 1080p MJPG, decodes, and scales.
 *  3. The `v4l2-ctl` probe itself failed (device busy, missing tool, timeout)
 *     so there is no mode list at all → bare negotiation, as before.
 */
export function buildV4l2Source(
    device: string,
    width: number,
    height: number,
    framerate: number,
    scaleStage: string = softwareScaleStage(width, height),
): string {
    let modes: CaptureMode[] | undefined;
    try {
        const stdout = execFileSync('v4l2-ctl', ['--device', device, '--list-formats-ext'], {
            encoding: 'utf-8',
            timeout: 2000,
        });
        modes = parseFormats(stdout);
    } catch {
        /* probe failed — leave `modes` undefined for bare negotiation */
    }
    return buildV4l2SourceForModes(device, width, height, framerate, modes, scaleStage);
}
