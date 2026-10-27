import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
    SUBTITLE_DEMUX_NAME,
    SUBTITLE_INPUT_PORT,
    SUBTITLE_OVERLAY_LIVE_KEYS,
    SUBTITLE_OVERLAY_SCHEMA,
} from '@media-router/plugin-subtitle-core';
import { VideoPlayerModule } from './VideoPlayerModule.js';
import { VP_DEMUX_NAME } from './helpers/pipelines.js';

/**
 * The manifest cannot import from subtitle-core (it is JSON the loader reads
 * before any module code runs), so the subtitle port and controls are COPIED
 * into package.json. This pins the copy to the source of truth: a schema or
 * port change in subtitle-core that is not mirrored here fails the suite.
 */
// vitest runs from the repo root (vitest.config.ts); tsc builds tests too, so
// no import.meta here (the plugin build is CommonJS).
const manifest = JSON.parse(
    readFileSync(join(process.cwd(), 'plugins', 'video-player', 'package.json'), 'utf8'),
).mediaRouter;

describe('video-player manifest ↔ subtitle-core', () => {
    it('declares the shared subtitle input port verbatim', () => {
        expect(manifest.ports.find((p: { id: string }) => p.id === SUBTITLE_INPUT_PORT.id)).toEqual(
            SUBTITLE_INPUT_PORT,
        );
    });

    it('its demuxes serve its two input ports, the video input and Subtitles In (WI-P3-6)', () => {
        const of = (el: string) => (new VideoPlayerModule() as any).demuxInputOf(el);
        const ids = manifest.ports.map((p: { id: string }) => p.id);
        expect(ids).toContain(VideoPlayerModule.VIDEO_INPUT_PORT_ID);
        expect(of(VP_DEMUX_NAME)).toEqual({ port: VideoPlayerModule.VIDEO_INPUT_PORT_ID });
        expect(of(SUBTITLE_DEMUX_NAME)).toEqual({ port: SUBTITLE_INPUT_PORT.id });
        expect(of('subov')).toBeUndefined();
    });

    it('carries every shared overlay control verbatim', () => {
        for (const key of SUBTITLE_OVERLAY_LIVE_KEYS) {
            expect(manifest.configSchema.properties[key], key).toEqual(
                SUBTITLE_OVERLAY_SCHEMA[key],
            );
        }
    });
});
