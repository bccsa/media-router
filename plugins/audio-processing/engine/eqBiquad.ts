/**
 * RBJ cookbook biquads for the EQ response curve — one per `filter-type-N`
 * the UI exposes on `para-equalizer-x16-stereo`, plus the 4-pole HPF that sits
 * ahead of it.
 *
 * The type names are LSP's own (see `EQ_FILTER_TYPES` in `eqBands.ts`), which
 * is why this lives plugin-side: the mapping from an operator's band type to a
 * filter shape is this module's knowledge, not the UI's.
 *
 * `allpass` is flat in magnitude (it only moves phase) and `off` is out of
 * circuit, so both evaluate to 0 dB. `resonance` is drawn as a bell — close
 * enough for an operator-facing picture. `eqMode` (analogue model) and
 * `eqSlope` (steepness) are NOT modelled: the curve shows the band layout, not
 * a bit-exact simulation of the element.
 */

/** The 302M chain runs at a fixed 48 kHz. */
export const EQ_SAMPLE_RATE = 48000;

export interface EqBandSpec {
    /** LSP band type (`off` / `bell` / `hipass` / …). */
    type: string;
    freq: number;
    /** Band gain, dB. Ignored by the non-parametric types. */
    gain: number;
    q: number;
}

interface Biquad {
    b0: number;
    b1: number;
    b2: number;
    a0: number;
    a1: number;
    a2: number;
}

/** |H(e^jw)| in dB for one biquad at `freq`. */
function biquadMagnitudeDb(c: Biquad, freq: number, sampleRate: number): number {
    const w = (2 * Math.PI * freq) / sampleRate;
    const cos1 = Math.cos(w);
    const sin1 = Math.sin(w);
    const cos2 = Math.cos(2 * w);
    const sin2 = Math.sin(2 * w);
    // z^-1 = cos(w) - j·sin(w), so the imaginary parts pick up the minus sign.
    const numRe = c.b0 + c.b1 * cos1 + c.b2 * cos2;
    const numIm = -(c.b1 * sin1 + c.b2 * sin2);
    const denRe = c.a0 + c.a1 * cos1 + c.a2 * cos2;
    const denIm = -(c.a1 * sin1 + c.a2 * sin2);
    const den = denRe * denRe + denIm * denIm;
    if (den === 0) return 0;
    const mag = Math.sqrt((numRe * numRe + numIm * numIm) / den);
    // A notch is a true zero — floor it so the polyline stays finite.
    return mag > 0 ? Math.max(-120, 20 * Math.log10(mag)) : -120;
}

/** RBJ cookbook coefficients for one band. Null = the band is transparent. */
function bandBiquad(band: EqBandSpec, sampleRate: number): Biquad | null {
    const w0 = (2 * Math.PI * band.freq) / sampleRate;
    const cosW = Math.cos(w0);
    const sinW = Math.sin(w0);
    // Q=0 is a legal LSP value but divides by zero in the cookbook.
    const alpha = sinW / (2 * Math.max(0.05, band.q));
    // Peaking / shelving gain: A is the SQUARE ROOT of the linear gain.
    const A = 10 ** (band.gain / 40);
    const shelfAlpha = 2 * Math.sqrt(A) * alpha;

    switch (band.type) {
        case 'bell':
        case 'resonance':
            return {
                b0: 1 + alpha * A,
                b1: -2 * cosW,
                b2: 1 - alpha * A,
                a0: 1 + alpha / A,
                a1: -2 * cosW,
                a2: 1 - alpha / A,
            };
        case 'loshelf':
            return {
                b0: A * (A + 1 - (A - 1) * cosW + shelfAlpha),
                b1: 2 * A * (A - 1 - (A + 1) * cosW),
                b2: A * (A + 1 - (A - 1) * cosW - shelfAlpha),
                a0: A + 1 + (A - 1) * cosW + shelfAlpha,
                a1: -2 * (A - 1 + (A + 1) * cosW),
                a2: A + 1 + (A - 1) * cosW - shelfAlpha,
            };
        case 'hishelf':
            return {
                b0: A * (A + 1 + (A - 1) * cosW + shelfAlpha),
                b1: -2 * A * (A - 1 + (A + 1) * cosW),
                b2: A * (A + 1 + (A - 1) * cosW - shelfAlpha),
                a0: A + 1 - (A - 1) * cosW + shelfAlpha,
                a1: 2 * (A - 1 - (A + 1) * cosW),
                a2: A + 1 - (A - 1) * cosW - shelfAlpha,
            };
        case 'notch':
            return { b0: 1, b1: -2 * cosW, b2: 1, a0: 1 + alpha, a1: -2 * cosW, a2: 1 - alpha };
        case 'hipass':
            return {
                b0: (1 + cosW) / 2,
                b1: -(1 + cosW),
                b2: (1 + cosW) / 2,
                a0: 1 + alpha,
                a1: -2 * cosW,
                a2: 1 - alpha,
            };
        case 'lopass':
            return {
                b0: (1 - cosW) / 2,
                b1: 1 - cosW,
                b2: (1 - cosW) / 2,
                a0: 1 + alpha,
                a1: -2 * cosW,
                a2: 1 - alpha,
            };
        default:
            return null;
    }
}

/** One band's contribution at `freq`, dB. 0 for an off / transparent band. */
export function bandMagnitudeDb(
    band: EqBandSpec,
    freq: number,
    sampleRate = EQ_SAMPLE_RATE,
): number {
    const biquad = bandBiquad(band, sampleRate);
    return biquad ? biquadMagnitudeDb(biquad, freq, sampleRate) : 0;
}

/**
 * The `audiocheblimit` HPF ahead of the EQ, drawn as two cascaded Butterworth
 * sections — the same 24 dB/octave slope as the 4-pole Chebyshev the chain
 * actually builds, without its passband ripple.
 */
export function hpfMagnitudeDb(cutoff: number, freq: number, sampleRate = EQ_SAMPLE_RATE): number {
    const section: EqBandSpec = { type: 'hipass', freq: cutoff, gain: 0, q: Math.SQRT1_2 };
    return 2 * bandMagnitudeDb(section, freq, sampleRate);
}
