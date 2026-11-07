import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parseManifestTiming, withIngestTimingSettings } from '@media-router/shared-types';
import { checkStartSettings } from '../modules/startSettings.js';
import { GstChildProcess } from '../child-process/GstChildProcess.js';
import * as engine from '../index.js';

/**
 * The guard for the timing settings and mechanisms Phase 4 deleted (B-171, S18; OQ-33): no
 * manifest declares them, a stored config carrying them starts unchanged, and nothing in the
 * tree names them but this file. The one place their names may stand.
 */
const ROOT = path.resolve(__dirname, '../../../..');
const PLUGINS_DIR = path.join(ROOT, 'plugins');

/** Removed keys with a stored value each: on every plugin, or on the one named. */
const REMOVED: Record<string, Record<string, unknown>> = {
    '*': {
        playoutOffsetMs: 300,
        lipSyncMs: -40,
        syncOffsetMs: 40,
        mixLatencyMs: 400,
        subtitleDelayMs: 1400,
    },
    'video-player': { sync: true, bufferMs: 1500 },
    'audio-decoder': { slaveMethod: 2, lowLatencySync: true, bufferMs: 1500, sinkBufferMs: 400 },
};
/** The headings they showed, so a renamed key cannot bring one back. */
const REMOVED_TITLES = ['Playout Offset', 'Lip-Sync Trim', 'Sync Trim', 'Subtitle Sync Delay'];

/** The S18 acceptance grep: what the deleted mechanisms were called. */
const GONE =
    /playoutOffset|PLAYOUT_OFFSET|PlayoutRaise|playoutReanchor|PLAYOUT_REANCHOR|playout_reanchor|onLateness|backlogShed|backlog_shed|BacklogShed|BACKLOG_SHED|MR_PLAYOUT|onRoutePlayout|lipSyncMs|syncOffsetMs|mixLatencyMs|subtitleDelayMs|effectiveLatchRepair/;
const SCANNED = /\.(ts|py|cpp|h|json)$/;

function removedFor(pluginId: string): Record<string, unknown> {
    return { ...REMOVED['*'], ...(REMOVED[pluginId] ?? {}) };
}

/** Every plugin's schema as the loader builds it (ingest timing settings added). */
function schemas(): Array<{ id: string; schema: Record<string, unknown> }> {
    const out: Array<{ id: string; schema: Record<string, unknown> }> = [];
    for (const id of fs.readdirSync(PLUGINS_DIR).sort()) {
        const file = path.join(PLUGINS_DIR, id, 'package.json');
        if (!fs.existsSync(file)) continue;
        const manifest = JSON.parse(fs.readFileSync(file, 'utf8')).mediaRouter;
        if (!manifest?.configSchema) continue;
        const timing = parseManifestTiming(manifest.timing);
        const schema = timing
            ? withIngestTimingSettings(manifest.configSchema, timing)
            : manifest.configSchema;
        out.push({ id, schema });
    }
    return out;
}

function walk(dir: string, out: string[]): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (SCANNED.test(e.name)) out.push(p);
    }
    return out;
}

describe('the removed timing settings and mechanisms (B-171, OQ-33)', () => {
    const all = schemas();

    it('finds the plugin manifests', () => {
        expect(all.length).toBeGreaterThan(20);
    });

    it('no manifest declares one, nor shows its heading', () => {
        const found: string[] = [];
        for (const { id, schema } of all) {
            const props = (schema.properties ?? {}) as Record<string, { title?: unknown }>;
            for (const key of Object.keys(removedFor(id))) {
                if (key in props) found.push(`${id}.${key}`);
            }
            for (const [key, prop] of Object.entries(props)) {
                if (REMOVED_TITLES.includes(prop.title as string)) found.push(`${id}.${key}`);
            }
        }
        expect(found).toEqual([]);
    });

    it('a stored config carrying them passes the start check with them unchanged', () => {
        for (const { id, schema } of all) {
            const stored = removedFor(id);
            const settings = structuredClone(stored);
            const fixes = checkStartSettings(schema, settings);
            for (const [key, value] of Object.entries(stored)) {
                expect(settings[key], `${id}.${key}`).toEqual(value);
            }
            const named = (fixes?.errors ?? []).filter((e) =>
                Object.keys(stored).some((k) => e.includes(k)),
            );
            expect(named, id).toEqual([]);
        }
    });

    it('nothing in packages or plugins names them but this guard (the S18 grep)', () => {
        const files = [...walk(path.join(ROOT, 'packages'), []), ...walk(PLUGINS_DIR, [])];
        expect(files.length).toBeGreaterThan(1000);
        const hits = files
            .filter((f) => GONE.test(fs.readFileSync(f, 'utf8')))
            .map((f) => path.relative(ROOT, f));
        expect(hits).toEqual(['packages/engine/src/plugins/removedTimingSettings.test.ts']);
    });

    it('their files are gone, Phase 2 leftovers included', () => {
        for (const file of [
            'packages/engine/src/plugins/playoutOffset.ts',
            'packages/engine/src/plugins/playoutReanchor.ts',
            'packages/engine/src/plugins/backlogShed.ts',
            'packages/engine/src/plugins/latchRepair.ts',
            'packages/engine/src/routing/PlayoutRaises.ts',
            'packages/engine/src/routing/MediaRouter.latchRepair.test.ts',
            'packages/engine/src/child-process/backlog_shed.py',
            'packages/engine/native/mr-gst-runner/backlog_shed.cpp',
        ]) {
            expect(fs.existsSync(path.join(ROOT, file)), file).toBe(false);
        }
        const makefile = path.join(ROOT, 'packages/engine/native/mr-gst-runner/Makefile');
        expect(fs.readFileSync(makefile, 'utf8')).not.toContain('backlog_shed');
        const router = path.join(ROOT, 'packages/engine/src/routing/MediaRouter.ts');
        expect(fs.readFileSync(router, 'utf8')).not.toContain('getUpstreamBusProducers');
    });

    it('the engine exports none of their API', () => {
        for (const name of [
            'effectivePlayoutOffsetMs',
            'DEFAULT_PLAYOUT_OFFSET_MS',
            'PLAYOUT_OFFSET_KEY',
            'backlogShedConfig',
            'BACKLOG_SHED_EVENT',
            'PLAYOUT_WATCH_EVENT',
            'readPlayoutWatch',
        ]) {
            expect(engine, name).not.toHaveProperty(name);
        }
    });

    it('a shedder field an older description still sets never reaches either runner', () => {
        const child = new GstChildProcess('/nonexistent/gst-runner.js') as unknown as {
            startPayload(desc: Record<string, unknown>): Record<string, unknown>;
        };
        const desc = { pipeline: 'fakesrc ! fakesink', backlogShed: { element: 'sink' } };
        expect(child.startPayload(desc)).not.toHaveProperty('backlogShed');
    });
});
