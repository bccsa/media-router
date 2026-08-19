/**
 * AES67 / SMPTE ST 2110-30 pipeline-string helpers (ADR-0005 decision 7).
 *
 * Shared by `aes67-input` (network → 302M bus) and `aes67-output` (302M bus →
 * network) so the two ends of the same stream cannot disagree about caps,
 * payload types or packet time. The SAP/SDP half of the domain lives in
 * `plugins/aes67-core/py` (one definition, in python, used by the sidecar both
 * plugins spawn) — nothing here restates it.
 *
 * AES67 essentials this encodes:
 * - 48 kHz, L24 (or L16) linear PCM, RTP/AVP with a dynamic payload type.
 * - 1 ms default packet time (48 samples), pinned at the payloader with
 *   `min-ptime` == `max-ptime` so the packetiser never coalesces.
 * - DSCP EF (46) for the media stream — AES67 §6.2's QoS recommendation, and
 *   the practical difference between "works on a shared LAN" and "clicks".
 * - RFC 7273 clock signalling (`a-ts-refclk` / `a-mediaclk` caps fields, which
 *   are how GStreamer carries the SDP attributes of the same name) so a
 *   PTP-locked receiver can reconstruct the sender's media clock.
 */

/** The IPv4 SAP announcement group + port (RFC 2974) every AES67 device uses. */
export const AES67_SAP_GROUP = '239.255.255.255';
export const AES67_SAP_PORT = 9875;

/** AES67 is 48 kHz-only in practice (and 302M on the bus side is 48 kHz-only, full stop). */
export const AES67_SAMPLE_RATE = 48000;

/** DSCP EF (Expedited Forwarding) — AES67's recommended media marking. */
export const AES67_DEFAULT_DSCP = 46;

/** Default packet time in ms: AES67's mandatory-to-support 1 ms (48 samples). */
export const AES67_DEFAULT_PTIME_MS = 1;

/** L24 = 24-bit, L16 = 16-bit linear PCM (RFC 3190 / RFC 3551). */
export type Aes67Encoding = 'L24' | 'L16';

/** The raw sample format each encoding payloads from — big-endian, always. */
export function aes67RawFormat(encoding: Aes67Encoding): 'S24BE' | 'S16BE' {
    return encoding === 'L16' ? 'S16BE' : 'S24BE';
}

export function aes67PayloaderElement(encoding: Aes67Encoding): string {
    return encoding === 'L16' ? 'rtpL16pay' : 'rtpL24pay';
}

export function aes67DepayloaderElement(encoding: Aes67Encoding): string {
    return encoding === 'L16' ? 'rtpL16depay' : 'rtpL24depay';
}

/** Raw-audio capsfilter clause feeding the payloader / leaving the depayloader. */
export function aes67RawCaps(encoding: Aes67Encoding, channels: number): string {
    return (
        `audio/x-raw,format=${aes67RawFormat(encoding)},rate=${AES67_SAMPLE_RATE}` +
        `,channels=${clampChannels(channels)},layout=interleaved`
    );
}

export interface Aes67RtpCapsOpts {
    encoding: Aes67Encoding;
    channels: number;
    payloadType: number;
    /**
     * RFC 7273 clock signalling. Only set when the stream really is locked to
     * that grandmaster: `rfc7273-sync` makes the receiver schedule off the PTP
     * clock, so a wrong (or invented) reference is worse than none.
     */
    ptpGmid?: string;
    ptpDomain?: number;
}

/**
 * `application/x-rtp` caps for the receiving `udpsrc`.
 *
 * RTP carries no format description of its own, so these caps ARE the SDP as
 * far as the depayloader is concerned — an operator entering them wrong is the
 * likeliest reason a stream stays silent, which is why the discovery picker
 * fills them from the sender's own announcement.
 *
 * `a-ts-refclk` / `a-mediaclk` are the caps spelling of the SDP attributes of
 * the same name (GStreamer prefixes SDP attributes with `a-`), and are what
 * `rtpjitterbuffer rfc7273-sync=true` reads.
 */
export function aes67RtpCaps(opts: Aes67RtpCapsOpts): string {
    const fields = [
        'application/x-rtp',
        'media=(string)audio',
        `clock-rate=(int)${AES67_SAMPLE_RATE}`,
        `encoding-name=(string)${opts.encoding}`,
        `channels=(int)${clampChannels(opts.channels)}`,
        `payload=(int)${clampPayloadType(opts.payloadType)}`,
    ];
    if (opts.ptpGmid) {
        // The BACKSLASHES are load-bearing. Both values contain `=`, so they
        // have to be quoted inside the structure — and the structure is itself
        // inside the `caps="…"` clause of a launch string, so the inner quotes
        // must reach `gst_parse_launch` escaped. Measured on gst 1.28: the
        // escaped-quote form parses back to `ptp=IEEE1588-2008:…`, while both
        // `\=`-escaping and single quotes fail the property set outright.
        fields.push(
            `a-ts-refclk=(string)\\"ptp=IEEE1588-2008:${opts.ptpGmid}:${opts.ptpDomain ?? 0}\\"`,
        );
        // `direct=0` = the RTP timestamp IS the PTP-epoch media clock. It is the
        // only mediaclk form we emit, and the only one a sender that derives its
        // timestamp-offset from TAI can honestly claim.
        fields.push('a-mediaclk=(string)\\"direct=0\\"');
    }
    return fields.join(', ');
}

/**
 * `min-ptime`/`max-ptime` clauses pinning the payloader to one packet time.
 *
 * Equal bounds are the point: AES67 receivers size their buffers in packet
 * times, and a payloader left free to coalesce (max-ptime unset = "up to the
 * MTU") would emit 5 ms packets on a quiet link and 1 ms ones under load.
 */
export function aes67PtimeClauses(ptimeMs: number): string {
    const ns = Math.round(clampPtime(ptimeMs) * 1_000_000);
    return `min-ptime=${ns} max-ptime=${ns}`;
}

/** Samples per packet at a given packet time — the payload sizing AES67 talks in. */
export function aes67SamplesPerPacket(ptimeMs: number): number {
    return Math.round((clampPtime(ptimeMs) * AES67_SAMPLE_RATE) / 1000);
}

/**
 * Bytes of RTP payload per packet — `samples x channels x sample size`.
 * Used to sanity-check the MTU: a packet that cannot fit is a configuration
 * error the operator should see before the wire does.
 */
export function aes67PayloadBytes(
    encoding: Aes67Encoding,
    channels: number,
    ptimeMs: number,
): number {
    const bytesPerSample = encoding === 'L16' ? 2 : 3;
    return aes67SamplesPerPacket(ptimeMs) * clampChannels(channels) * bytesPerSample;
}

/** AES67 supports 1-8 channels; the value is also an RTP caps field, so bound it. */
export function clampChannels(channels: number): number {
    const n = Math.trunc(Number(channels));
    if (!Number.isFinite(n) || n < 1) return 1;
    return Math.min(8, n);
}

/** Dynamic RTP payload types are 96-127 (RFC 3551 §6). */
export function clampPayloadType(pt: number): number {
    const n = Math.trunc(Number(pt));
    if (!Number.isFinite(n)) return 96;
    return Math.min(127, Math.max(96, n));
}

/** AES67 packet times run 125 µs to 4 ms; outside that no receiver has to interoperate. */
export function clampPtime(ptimeMs: number): number {
    const n = Number(ptimeMs);
    if (!Number.isFinite(n) || n <= 0) return AES67_DEFAULT_PTIME_MS;
    return Math.min(4, Math.max(0.125, n));
}
