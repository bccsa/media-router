import type { ThroughputSample } from '@media-router/engine';
import type { Rendition, TranscoderOutput } from './transcoderPorts.js';

/**
 * Operator-facing status text for the transcoder's rendition ladder. Pure
 * formatting, split from `TranscoderModule` to keep the module one screen
 * of lifecycle.
 */

/** e.g. `1920x1080@5000k [v4l2, cbr], 854x480@1200k` — flags only the knobs a
 *  rendition actually overrides, using the resolved value so 'auto'/inherited
 *  entries don't show noise. */
export function renditionSummary(outputs: TranscoderOutput[]): string {
    return outputs
        .map((o) => {
            const r = o.rendition;
            const tags: string[] = [];
            if (r.codec) tags.push(o.encode.codec);
            if (r.encoderImpl) tags.push(o.encode.impl);
            if (r.rateControl) tags.push(o.encode.rateControl);
            if (r.speedPreset) tags.push(o.encode.speedPreset);
            if (r.h264Profile && r.h264Profile !== 'auto') tags.push(o.encode.h264Profile);
            if (r.sceneCut !== undefined) tags.push(`sc${o.encode.sceneCut}`);
            const suffix = tags.length ? ` [${tags.join(', ')}]` : '';
            return `${r.width}x${r.height}@${r.bitrate}k${suffix}`;
        })
        .join(', ');
}

/**
 * Label for a per-rendition throughput row, e.g. `1280x720 @ 2500k`. Named
 * distinctly from `transcoderPorts.renditionLabel` (which returns the
 * operator-facing output name) — same family, different output.
 */
export function renditionStatLabel(r: Rendition | undefined, i: number): string {
    return r ? `${r.width}x${r.height} @ ${r.bitrate}k` : `Rendition ${i + 1}`;
}

/**
 * The PER-RENDITION live-throughput section — one row per quality plus a
 * Total (the face badge stays the aggregate so the node shows one headline
 * number). `fields` describes the dynamic section, `data` its values.
 */
export function throughputSection(
    sinkNames: string[],
    renditions: Array<Rendition | undefined>,
    total: ThroughputSample,
    perSink: Record<string, ThroughputSample>,
): {
    fields: Array<{ key: string; label: string; unit?: string }>;
    data: Record<string, number | string>;
} {
    const fields: Array<{ key: string; label: string; unit?: string }> = [];
    const data: Record<string, number | string> = {};
    for (let i = 0; i < sinkNames.length; i++) {
        const sample = perSink[sinkNames[i]];
        if (!sample) continue;
        fields.push({ key: `r${i}`, label: renditionStatLabel(renditions[i], i), unit: 'Mbps' });
        data[`r${i}`] = Math.round(sample.bitrateKbps / 10) / 100;
    }
    fields.push({ key: 'total', label: 'Total', unit: 'Mbps' });
    data.total = Math.round(total.bitrateKbps / 10) / 100;
    fields.push({ key: 'totalBytes', label: 'Total Bytes' });
    data.totalBytes = `${(total.totalBytes / 1024 / 1024).toFixed(1)} MB`;
    return { fields, data };
}
