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

import { gstElementEnumHasValue, probeGstElement } from './gstInspect.js';
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

/** Per codec: does its VA element's `rate-control` list `qvbr` here? */
export type VaQvbrAvailability = Record<CodecId, boolean>;

function noVaQvbr(): VaQvbrAvailability {
    return { h264: false, h265: false, av1: false };
}

/** Probe `qvbr` in each installed VA element's per-driver rate-control enum. */
async function probeVaQvbr(
    elements: Record<CodecId, Partial<Record<ImplId, string>>>,
    availability: Record<CodecId, ImplId[]>,
): Promise<VaQvbrAvailability> {
    const codecs = Object.keys(availability) as CodecId[];
    const found = await Promise.all(
        codecs.map((c) => {
            const el = elements[c]?.va;
            return el && availability[c].includes('va')
                ? gstElementEnumHasValue(el, 'rate-control', 'qvbr')
                : Promise.resolve(false);
        }),
    );
    const out = noVaQvbr();
    codecs.forEach((c, i) => (out[c] = found[i]));
    return out;
}

export class ProbedEncoders {
    /** Impls whose GStreamer element is actually installed, per codec. */
    readonly availability: Record<CodecId, ImplId[]>;
    /** Hardware scalers installed. All-false unless `probeHwScalers` was set. */
    readonly hwScalers: HwScalerAvailability;
    /** VA elements whose driver offers QVBR (`buildEncoderBranch`'s `vaQvbr`). */
    readonly vaQvbr: VaQvbrAvailability;

    private constructor(
        availability: Record<CodecId, ImplId[]>,
        hwScalers: HwScalerAvailability,
        vaQvbr: VaQvbrAvailability,
    ) {
        this.availability = availability;
        this.hwScalers = hwScalers;
        this.vaQvbr = vaQvbr;
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
        const vaQvbr = await probeVaQvbr(elements, availability);
        return new ProbedEncoders(availability, { va, v4l2 }, vaQvbr);
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
        return new ProbedEncoders(emptyAvailability(), { va: false, v4l2: false }, noVaQvbr());
    }

    static forTest(
        availability: Partial<Record<CodecId, ImplId[]>>,
        hwScalers: Partial<HwScalerAvailability> = {},
        vaQvbr: Partial<VaQvbrAvailability> = {},
    ): ProbedEncoders {
        return new ProbedEncoders(
            { ...emptyAvailability(), ...availability },
            { va: false, v4l2: false, ...hwScalers },
            { ...noVaQvbr(), ...vaQvbr },
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
