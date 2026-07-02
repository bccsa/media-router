/**
 * Runtime encoder-availability probing shared by the codec plugins
 * (video-encoder, transcoder). Splits the GStreamer-dependent half of the
 * encoder helpers away from the pure `encoderElements.ts` builder so that file
 * stays import-free and unit-testable with plain inputs.
 */

import { probeGstElement } from './gstInspect.js';
import { resolveImpl, type CodecId, type ImplId } from './encoderElements.js';

/**
 * Probe every {codec × impl} element in `elements` with `gst-inspect` and return
 * the impls actually installed per codec. `initManifest` stores this so
 * `resolveImpl` picks an impl that exists rather than one that merely appears in
 * the static table.
 */
export async function probeEncoderAvailability(
    elements: Record<CodecId, Partial<Record<ImplId, string>>>,
): Promise<Record<CodecId, ImplId[]>> {
    const availability = Object.fromEntries(
        (Object.keys(elements) as CodecId[]).map((c) => [c, [] as ImplId[]]),
    ) as Record<CodecId, ImplId[]>;
    await Promise.all(
        (Object.keys(elements) as CodecId[]).flatMap((codec) =>
            (Object.entries(elements[codec]) as Array<[ImplId, string]>).map(
                async ([impl, element]) => {
                    if (await probeGstElement(element)) availability[codec].push(impl);
                },
            ),
        ),
    );
    return availability;
}

/**
 * Reflect a probed availability map into a plugin manifest in place: narrow the
 * `codec` enum to codecs with at least one installed encoder, and build the
 * `encoderImpl` `x-enumBy` map so the UI dropdown only offers impls the host can
 * honour per codec. No-op when the schema has no `properties`.
 *
 * Also fixes the `auto` entry of any `x-showWhen: "encoderImpl=…"` visibility
 * rule: fields like scene-cut are only honoured by some impls, and whether
 * `auto` lands on such an impl is only known after probing THIS box. `auto` is
 * kept in the show-list when auto-resolution picks one of the field's impls and
 * removed otherwise (resolved for H.264 as the representative codec — the
 * impl-sensitive fields are the x264/x265 software knobs, and auto resolves the
 * same way for H.264 and H.265 on real hardware).
 */
export function applyEncoderAvailabilityToManifest(
    manifest: Record<string, any>,
    availability: Record<CodecId, ImplId[]>,
): void {
    const props = (manifest.configSchema as any)?.properties;
    if (!props) return;

    const availableCodecs = (Object.keys(availability) as CodecId[]).filter(
        (c) => availability[c].length > 0,
    );
    if (props.codec && availableCodecs.length > 0) {
        props.codec.enum = availableCodecs;
    }
    if (props.encoderImpl) {
        const implMap: Record<string, string[]> = {};
        for (const c of Object.keys(availability) as CodecId[]) {
            implMap[c] = ['auto', ...availability[c]];
        }
        props.encoderImpl['x-enumBy'] = { field: 'codec', map: implMap };
    }

    const autoImpl = resolveImpl('h264', 'auto', availability.h264 ?? []);
    for (const prop of Object.values(props) as Array<Record<string, unknown>>) {
        const rule = prop?.['x-showWhen'];
        if (typeof rule !== 'string' || !rule.startsWith('encoderImpl=')) continue;
        const impls = rule
            .slice('encoderImpl='.length)
            .split(',')
            .filter((v) => v !== 'auto');
        if (autoImpl && impls.includes(autoImpl)) impls.push('auto');
        prop['x-showWhen'] = `encoderImpl=${impls.join(',')}`;
    }
}
