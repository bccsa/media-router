import { describe, it, expect } from 'vitest';
import { repoPlugin } from './routerRig.js';

describe('repoPlugin: the timing settings as PluginLoader adds them', () => {
    it('an egress manifest gains none, a network ingest all three (WI-P5-10, S34)', () => {
        for (const id of ['srt-output', 'rist-output', 'mpegts-ip-output']) {
            const props = repoPlugin(id).schema.properties as Record<string, unknown>;
            expect(props).not.toHaveProperty('ingestOffsetMs');
            expect(props).not.toHaveProperty('pidTrimsMs');
            expect(props).not.toHaveProperty('smoothingCooldownMin');
        }
        const ingest = repoPlugin('srt-input');
        expect(ingest.schema.properties).toHaveProperty('ingestOffsetMs');
        expect(ingest.schema.properties).toHaveProperty('pidTrimsMs');
        expect(ingest.schema.properties).toHaveProperty('smoothingCooldownMin');
        expect(ingest.live).toContain('ingestOffsetMs');
    });
});
