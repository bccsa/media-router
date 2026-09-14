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

    it('subtitle input is a bus TS input into a named tsdemux', () => {
        const s = buildSubtitleInput({
            port: 40123,
            socketPath: '/run/x.sock',
            demuxName: 'subdemux',
        });
        expect(s).toMatch(/^unixfdsrc /);
        expect(s).toContain('/run/x.sock');
        expect(s).toContain('tsparse set-timestamps=false');
        expect(s).toMatch(/! tsdemux name=subdemux latency=0$/);
    });

    it('pay tail muxes the KLV appsrc as the sole, PCR-carrying stream', () => {
        expect(
            buildSubtitlePayTail({
                appsrcName: 'subsrc_0',
                muxName: 'mux_0',
                pid: 0x180,
                port: 40200,
            }),
        ).toBe(
            'appsrc name=subsrc_0 is-live=false format=time block=false caps="meta/x-klv,parsed=true" ! mux_0.sink_384 ' +
                'mpegtsmux name=mux_0 alignment=7 prog-map="program_map,sink_384=(int)1,PCR_1=sink_384" ! ' +
                'capssetter caps="video/mpegts, systemstream=(boolean)true, packetsize=(int)188" replace=true ! ' +
                'capsfilter caps="video/mpegts, systemstream=(boolean)true, packetsize=(int)188" ! ' +
                'tee name=busout_40200 allow-not-linked=true',
        );
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
