/**
 * Probed encoder capability of THIS host, as one value.
 *
 * Every codec plugin needs the same three things after `initManifest`: which
 * impls are installed per codec, whether the matching hardware scaler is
 * installed, and a resolver that turns the operator's `auto`/explicit choice
 * into a concrete impl. Each plugin used to carry that as a private static plus
 * a `setAvailableImpls` test seam; this class owns it instead, so the probing
 * and the resolve boilerplate exist once.
 *
 * Composes `probeEncoderAvailability` / `applyEncoderAvailabilityToManifest`
 * rather than replacing them — those stay independently usable and tested.
 */

import { probeGstElement } from './gstInspect.js';
import { ENCODER_ELEMENTS, resolveImpl, type CodecId, type ImplId } from './encoderElements.js';
import { probeEncoderAvailability, applyEncoderAvailabilityToManifest } from './encoderManifest.js';

/**
 * Hardware scale/convert elements that pair with a hardware encoder impl:
 * `vapostproc` with vah26Xenc (scale + format convert + GPU upload in one step,
 * handing the encoder frames already in VA memory), `v4l2convert` with
 * v4l2h26Xenc (the Pi ISP M2M scaler; bcm2835 only — Pi 5 exposes neither).
 */
export interface HwScalerAvailability {
    va: boolean;
    v4l2: boolean;
}

export interface ProbeEncodersOptions {
    /** Also probe `vapostproc` / `v4l2convert`. Only pipelines that can offload
     *  their scale stage need this — leave it off and `hwScalers` stays all-false. */
    probeHwScalers?: boolean;
}

/** All codecs with no impls — the pre-probe value. */
function emptyAvailability(): Record<CodecId, ImplId[]> {
    return { h264: [], h265: [], av1: [] };
}

export class ProbedEncoders {
    /** Impls whose GStreamer element is actually installed, per codec. */
    readonly availability: Record<CodecId, ImplId[]>;
    /** Hardware scalers installed. All-false unless `probeHwScalers` was set. */
    readonly hwScalers: HwScalerAvailability;

    private constructor(availability: Record<CodecId, ImplId[]>, hwScalers: HwScalerAvailability) {
        this.availability = availability;
        this.hwScalers = hwScalers;
    }

    /**
     * Probe the host. Call from a plugin's static `initManifest`; the underlying
     * `gst-inspect` results are cached per process, so repeated calls across
     * plugins cost one spawn per element.
     */
    static async probe(
        elements: Record<CodecId, Partial<Record<ImplId, string>>> = ENCODER_ELEMENTS,
        opts: ProbeEncodersOptions = {},
    ): Promise<ProbedEncoders> {
        const [availability, va, v4l2] = await Promise.all([
            probeEncoderAvailability(elements),
            opts.probeHwScalers ? probeGstElement('vapostproc') : Promise.resolve(false),
            opts.probeHwScalers ? probeGstElement('v4l2convert') : Promise.resolve(false),
        ]);
        return new ProbedEncoders(availability, { va, v4l2 });
    }

    /**
     * Construct without probing. The injection point for tests (replaces the
     * plugins' `setAvailableImpls` statics) and the right pre-probe placeholder
     * for a test double. Production code starts from `unprobed()`, never from
     * this. Codecs left out of `availability` count as having no encoder.
     */
    /**
     * The pre-probe host: no encoder, no scaler. Production modules start from
     * this so a build before/without `probe()` fails cleanly ("no encoder
     * available") rather than naming an element that isn't installed.
     */
    static unprobed(): ProbedEncoders {
        return new ProbedEncoders(emptyAvailability(), { va: false, v4l2: false });
    }

    static forTest(
        availability: Partial<Record<CodecId, ImplId[]>>,
        hwScalers: Partial<HwScalerAvailability> = {},
    ): ProbedEncoders {
        return new ProbedEncoders(
            { ...emptyAvailability(), ...availability },
            { va: false, v4l2: false, ...hwScalers },
        );
    }

    /** The operator's `auto`/explicit choice as a concrete installed impl, or
     *  null when nothing satisfies it (see `resolveImpl` for the auto order). */
    resolve(codec: CodecId, choice: ImplId | 'auto' | undefined): ImplId | null {
        return resolveImpl(codec, choice ?? 'auto', this.availability[codec] ?? []);
    }

    /** Stamp this host's availability into the plugin's manifest so the GUI
     *  only offers impls that exist here. */
    applyToManifest(manifest: Record<string, any>): void {
        applyEncoderAvailabilityToManifest(manifest, this.availability);
    }
}
