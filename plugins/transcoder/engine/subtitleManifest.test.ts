import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
    SUBTITLE_DEMUX_NAME,
    SUBTITLE_INPUT_PORT,
    SUBTITLE_OVERLAY_LIVE_KEYS,
    SUBTITLE_OVERLAY_SCHEMA,
} from '@media-router/plugin-subtitle-core';
import { TranscoderModule } from './TranscoderModule.js';
import { DEMUX_NAME } from './transcoderPipeline.js';
import { buildDynamicPorts } from './transcoderPorts.js';

/**
 * The subtitle controls are COPIED into package.json (the loader reads the
 * manifest before any module code runs); this pins the copy to subtitle-core.
 * The subtitle input port is dynamic here, so it is checked on the port builder.
 */
const manifest = JSON.parse(
    readFileSync(join(process.cwd(), 'plugins', 'transcoder', 'package.json'), 'utf8'),
).mediaRouter;

describe('transcoder ↔ subtitle-core', () => {
    it('exposes the shared subtitle input port ahead of the renditions', () => {
        const ports = buildDynamicPorts([{ name: '', width: 1280, height: 720, bitrate: 2500 }]);
        expect(ports.map((p) => p.id)).toEqual(['mpegts-in', 'subtitles-in', 'out-0']);
        expect(ports[1]).toEqual(SUBTITLE_INPUT_PORT);
    });

    it('its demuxes serve its two input ports, the TS input and Subtitles In (WI-P3-6)', () => {
        const [input, subtitles] = buildDynamicPorts([]);
        const of = (el: string) => (new TranscoderModule() as any).demuxInputOf(el);
        expect(of(DEMUX_NAME)).toEqual({ port: input.id });
        expect(of(SUBTITLE_DEMUX_NAME)).toEqual({ port: subtitles.id });
        expect(of('deint')).toBeUndefined();
    });

    it('carries every shared overlay control verbatim in its manifest', () => {
        for (const key of SUBTITLE_OVERLAY_LIVE_KEYS) {
            expect(manifest.configSchema.properties[key], key).toEqual(
                SUBTITLE_OVERLAY_SCHEMA[key],
            );
        }
    });

    it("has no Subtitle Sync Delay: burn-in waits by the cues' measured lateness (OQ-24)", () => {
        const props = manifest.configSchema.properties as Record<string, { title?: string }>;
        expect(props.subtitleDelayMs).toBeUndefined();
        expect(Object.values(props).map((p) => p.title)).not.toContain('Subtitle Sync Delay');
    });
});
