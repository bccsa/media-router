import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
    SUBTITLE_INPUT_PORT,
    SUBTITLE_OVERLAY_LIVE_KEYS,
    SUBTITLE_OVERLAY_SCHEMA,
} from '@media-router/plugin-subtitle-core';
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

    it('carries every shared overlay control verbatim in its manifest', () => {
        for (const key of SUBTITLE_OVERLAY_LIVE_KEYS) {
            expect(manifest.configSchema.properties[key], key).toEqual(
                SUBTITLE_OVERLAY_SCHEMA[key],
            );
        }
    });
});
