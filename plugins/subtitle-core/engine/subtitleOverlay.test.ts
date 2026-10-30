import { describe, it, expect } from 'vitest';
import {
    SUBTITLE_INPUT_PORT,
    SUBTITLE_OVERLAY_LIVE_KEYS,
    SUBTITLE_OVERLAY_SCHEMA,
    buildSubtitleInput,
    buildSubtitleOverlayElement,
    subtitleOverlayLiveUpdates,
    subtitleOverlayProps,
    subtitleRunnerHook,
} from './subtitleOverlay.js';
import { buildSubtitlePayTail } from './subtitlePay.js';
import { SUBTITLE_DEMUX_NAME, renderDemuxInput, subtitleRenderPlan } from './subtitleRender.js';

describe('subtitle overlay schema', () => {
    it('every key is live-updatable and has a default', () => {
        expect(SUBTITLE_OVERLAY_LIVE_KEYS).toEqual([
            'subtitlePosition',
            'subtitleAlign',
            'subtitleSize',
            'subtitleMargin',
            'subtitleBackground',
            'subtitleBackgroundOpacity',
        ]);
        for (const [key, prop] of Object.entries(SUBTITLE_OVERLAY_SCHEMA)) {
            expect(prop['x-live'], key).toBe(true);
            expect(prop.default, key).toBeDefined();
        }
    });
});

describe('subtitleOverlayProps', () => {
    it('defaults from an empty config match the schema defaults', () => {
        expect(subtitleOverlayProps({})).toEqual({
            valignment: 'bottom',
            halignment: 'center',
            'font-desc': 'Sans Bold 36',
            ypad: 40,
            'shaded-background': true,
            'shading-value': 153, // 60 %
        });
    });

    it('maps and clamps operator values', () => {
        expect(
            subtitleOverlayProps({
                subtitlePosition: 'top',
                subtitleAlign: 'left',
                subtitleSize: 999,
                subtitleMargin: -3,
                subtitleBackground: false,
                subtitleBackgroundOpacity: '90', // percent
            }),
        ).toEqual({
            valignment: 'top',
            halignment: 'left',
            'font-desc': 'Sans Bold 120',
            ypad: 0,
            'shaded-background': false,
            'shading-value': 230,
        });
        // junk collapses to defaults, never into the pipeline string
        expect(
            subtitleOverlayProps({ subtitlePosition: 'diagonal', subtitleSize: 'big' }),
        ).toMatchObject({
            valignment: 'bottom',
            'font-desc': 'Sans Bold 36',
        });
    });

    it('live updates name only the touched textoverlay properties', () => {
        expect(subtitleOverlayLiveUpdates({ bufferMs: 300 }, {})).toEqual([]);
        expect(
            subtitleOverlayLiveUpdates({ subtitleSize: 48, subtitleBackground: false }, {}),
        ).toEqual([
            { property: 'font-desc', value: 'Sans Bold 48' },
            { property: 'shaded-background', value: false },
        ]);
    });
});

describe('pipeline fragments', () => {
    it('overlay element starts empty and never waits for text', () => {
        expect(buildSubtitleOverlayElement('subov', {})).toBe(
            'textoverlay name=subov wait-text=false text="" valignment=bottom halignment=center ' +
                'font-desc="Sans Bold 36" ypad=40 shaded-background=true shading-value=153',
        );
    });

    it('subtitle input is a bus TS input into a named mrtsdemux, private streams only (WI-P3-7)', () => {
        const s = buildSubtitleInput({
            port: 40123,
            socketPath: '/run/x.sock',
            demuxName: 'subdemux',
        });
        expect(s).toMatch(/^unixfdsrc /);
        expect(s).toContain('/run/x.sock');
        expect(s).toContain('tsparse set-timestamps=false');
        expect(s).toMatch(/ ! mrtsdemux name=subdemux media=private$/);
        expect(s).not.toMatch(/\btsdemux\b/);
    });

    it('pay tail: the bridge-packed TS appsrc straight onto the bus, no mux', () => {
        expect(buildSubtitlePayTail({ appsrcName: 'subsrc_0', port: 40200 })).toBe(
            'appsrc name=subsrc_0 is-live=false format=time block=false ' +
                'caps="video/mpegts, systemstream=(boolean)true, packetsize=(int)188" ! ' +
                'capssetter caps="video/mpegts, systemstream=(boolean)true, packetsize=(int)188" replace=true ! ' +
                'capsfilter caps="video/mpegts, systemstream=(boolean)true, packetsize=(int)188" ! ' +
                'mrlateness name=lat_busout_40200 reference=running-time ! tee name=busout_40200 allow-not-linked=true',
        );
    });

    it('render plan pins the python runner (python-only hook by decision, ADR-0016 2026-10-09)', () => {
        expect(subtitleRenderPlan({ port: 5600 }, {}).runner).toBe('python');
    });

    it("names the renderer's pace group to the bridge only when given one (burn-in, WI-P3-13)", () => {
        const overlay = (plan: ReturnType<typeof subtitleRenderPlan>) =>
            (plan.runnerHooks[0].config as { overlay: Record<string, unknown> }).overlay;
        expect(overlay(subtitleRenderPlan({ port: 5600 }, {}))).toEqual({
            demux: 'subdemux',
            overlay: 'subov',
        });
        expect(overlay(subtitleRenderPlan({ port: 5600 }, {}, { aligner: 'burnin' }))).toEqual({
            demux: 'subdemux',
            overlay: 'subov',
            aligner: 'burnin',
        });
        // Only the hook changes: the overlay and the cue input are the same either way.
        const plain = subtitleRenderPlan({ port: 5600 }, {});
        const paced = subtitleRenderPlan({ port: 5600 }, {}, { aligner: 'burnin' });
        expect([paced.overlayElement, paced.inputFragment, paced.runner]).toEqual([
            plain.overlayElement,
            plain.inputFragment,
            plain.runner,
        ]);
    });

    it('tests/render-plan.json is the plan protocol subtitle-overlay-formula replays (`vitest -u` rewrites it)', async () => {
        // `@SOCK@` stands for the protocol case's socket directory.
        const plan = subtitleRenderPlan({ port: 40500, socketPath: '@SOCK@/subs.sock' }, {});
        await expect(`${JSON.stringify(plan, null, 2)}\n`).toMatchFileSnapshot(
            '../tests/render-plan.json',
        );
    });

    it("a renderer's demuxes: the cue demux serves Subtitles In, its own its video input (WI-P3-6)", () => {
        const main = { demux: 'vpdemux', port: 'mpegts-in' };
        expect(subtitleRenderPlan({ port: 5600 }, {}).inputFragment).toContain(
            `name=${SUBTITLE_DEMUX_NAME} `,
        );
        expect(renderDemuxInput(SUBTITLE_DEMUX_NAME, main)).toEqual({
            port: SUBTITLE_INPUT_PORT.id,
        });
        expect(renderDemuxInput('vpdemux', main)).toEqual({ port: 'mpegts-in' });
        expect(renderDemuxInput('subov', main)).toBeUndefined();
    });

    it('declares the shared subtitle input port', () => {
        expect(SUBTITLE_INPUT_PORT).toMatchObject({
            id: 'subtitles-in',
            direction: 'input',
            streamType: 'muxed/mpegts',
            maxConnections: 1,
        });
    });
});

describe('runner hook', () => {
    it('names the plugin python module and carries the pay/overlay config', () => {
        expect(subtitleRunnerHook({ overlay: { demux: 'd', overlay: 'o' } })).toEqual({
            module: 'subtitle_bridge',
            config: { overlay: { demux: 'd', overlay: 'o' } },
        });
    });
});
