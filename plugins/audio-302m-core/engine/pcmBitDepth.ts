/**
 * 302M PCM word length — the `pcmBitDepth` config every 302M producer exposes.
 *
 * `avenc_s302m` takes S16LE (16-bit 302M) or S32LE (24-bit 302M). The bus
 * default is 16-bit: a 10 ms stereo block is 1.9 kB instead of 2.9 kB, which
 * is a third fewer TS packets and unixfd buffers on every hop — measured on a
 * Pi 4 (gst 1.28) as ~14 % less CPU per producer+consumer pair, at zero added
 * latency. 24-bit is opt-in for the case where the PCM itself is delivered
 * (AES67 out, a 302M recorder) rather than re-encoded to Opus/AAC.
 * Decoders (`avdec_s302m`) read the word length from the 302M frame header,
 * so mixed depths on one bus are fine.
 */
export type S302mFormat = 'S16LE' | 'S32LE';

export const DEFAULT_302M_BIT_DEPTH = 16;

/** Map a module's `pcmBitDepth` config value onto the raw-audio format
 *  `build302mEncodeBranch` pins. Anything but 24 (unset, junk, 16) → 16-bit. */
export function s302mFormatFor(bitDepth: unknown): S302mFormat {
    return Number(bitDepth) === 24 ? 'S32LE' : 'S16LE';
}
