import { describe, it, expect, vi } from 'vitest';
import { TeletextSubtitlesModule } from './TeletextSubtitlesModule.js';

function makeModule(opts: { upstream?: { port: number; socketPath: string } | undefined } = {}) {
    const module = new TeletextSubtitlesModule();
    const getModuleBusSource = vi.fn((_id: string, _portId?: string) =>
        'upstream' in opts
            ? opts.upstream
            : { port: 5004, socketPath: '/tmp/mr-bus-5004-abc.sock' },
    );
    let nextPort = 41000;
    const assignBusChannel = vi.fn((_id: string, _portId?: string) => ({ port: nextPort++ }));
    (module as any).services = {
        instanceId: 'ttx-1',
        mediaRouter: { getModuleBusSource, assignBusChannel },
    };
    (module as any).setHealth = vi.fn();
    (module as any).setStatusData = vi.fn();
    (module as any).setFieldOptions = vi.fn();
    (module as any).emitConfigUpdate = vi.fn((changes: Record<string, unknown>) =>
        Object.assign((module as any).config, changes),
    );
    return { module, getModuleBusSource, assignBusChannel };
}

describe('getDynamicPorts', () => {
    it('input + one output per page, none before a page is picked or typed', () => {
        const { module } = makeModule();
        (module as any).config = {};
        expect(module.getDynamicPorts().map((p) => p.id)).toEqual(['mpegts-in']);
        (module as any).config = { pages: [{ page: 888 }, { page: 692 }] };
        expect(module.getDynamicPorts().map((p) => p.id)).toEqual([
            'mpegts-in',
            'page-888',
            'page-692',
        ]);
    });

    it('picked detected pages become ports labelled with the announced language', () => {
        const { module } = makeModule();
        (module as any).config = {
            detectedPages: ['692'],
            discoveredPages: [{ page: 692, language: 'nor', type: 2 }],
            pages: [],
        };
        const ports = module.getDynamicPorts();
        expect(ports.map((p) => p.id)).toEqual(['mpegts-in', 'page-692']);
        expect(ports[1].label).toBe('nor 692');
    });

    it('caps the ports at 8 pages', () => {
        const { module } = makeModule();
        (module as any).config = {
            detectedPages: ['100', '101', '102', '103', '104'],
            pages: [{ page: 200 }, { page: 201 }, { page: 202 }, { page: 203 }],
        };
        expect(module.getDynamicPorts()).toHaveLength(9);
    });
});

describe('buildPipeline', () => {
    it('warns and returns null with no source on the TS input', () => {
        const { module, getModuleBusSource } = makeModule({ upstream: undefined });
        expect(module.buildPipeline({ pages: [{ page: 888 }] })).toBeNull();
        expect(getModuleBusSource).toHaveBeenCalledWith('ttx-1', 'mpegts-in');
        expect((module as any).setHealth).toHaveBeenCalledWith(
            'warning',
            expect.stringContaining('No MPEG-TS source'),
        );
    });

    it('runs the PMT probe alone (and warns) with no pages selected', () => {
        const { module, assignBusChannel } = makeModule();
        const desc = module.buildPipeline({ pages: [], detectedPages: [] })!;
        expect(assignBusChannel).not.toHaveBeenCalled();
        expect(desc.tsProbe).toEqual({ appsink: 'tsprobe' });
        expect(desc.pipeline).not.toContain('tsdemux');
        expect(desc.runnerHooks).toBeUndefined();
        expect((module as any).setHealth).toHaveBeenLastCalledWith(
            'warning',
            expect.stringContaining('No pages selected'),
        );
        expect((module as any).setStatusData).toHaveBeenCalledWith('detected', {
            pages: 'waiting for the PMT',
        });
        // the base class sets ok on PLAYING — the hook must re-assert the warning
        (module as any).setHealth.mockClear();
        (module as any).onPipelinePlaying();
        expect((module as any).setHealth).toHaveBeenCalledWith(
            'warning',
            expect.stringContaining('No pages selected'),
        );
    });

    it('allocates one bus channel per page and hands the bridge its pay entries', () => {
        const { module, assignBusChannel } = makeModule();
        const desc = module.buildPipeline({
            pages: [
                { page: 888, language: 'eng' },
                { page: 692, language: 'nor' },
            ],
            cueHoldSeconds: 5,
        })!;
        expect(assignBusChannel).toHaveBeenCalledTimes(2);
        expect(assignBusChannel).toHaveBeenCalledWith('ttx-1', 'page-888');
        expect(assignBusChannel).toHaveBeenCalledWith('ttx-1', 'page-692');
        expect(desc.restartOnError).toBe(true);
        expect(desc.tsProbe).toEqual({ appsink: 'tsprobe' });
        expect(desc.pipeline).toContain('teletextdec name=ttx_0 page=888');
        expect(desc.pipeline).toContain('tee name=busout_41000');
        expect(desc.pipeline).toContain('tee name=busout_41001');
        expect(desc.runnerHooks).toHaveLength(1);
        expect(desc.runnerHooks![0].module).toBe('subtitle_bridge');
        expect((desc.runnerHooks![0].config as any).pay).toEqual([
            { appsink: 'ttxsink_0', appsrc: 'subsrc_0', holdMs: 5000, label: 'eng 888' },
            { appsink: 'ttxsink_1', appsrc: 'subsrc_1', holdMs: 5000, label: 'nor 692' },
        ]);
        expect((module as any).setHealth).toHaveBeenLastCalledWith('ok');
        expect((module as any).setStatusData).toHaveBeenCalledWith('input', { channel: 5004 });
    });

    it('clamps the cue hold to 1–30 s and defaults to 8 s', () => {
        const { module } = makeModule();
        expect(
            (
                module.buildPipeline({ pages: [{ page: 888 }], cueHoldSeconds: 500 })!
                    .runnerHooks![0].config as any
            ).pay[0].holdMs,
        ).toBe(30000);
        expect(
            (module.buildPipeline({ pages: [{ page: 888 }] })!.runnerHooks![0].config as any).pay[0]
                .holdMs,
        ).toBe(8000);
    });
});

describe('cue status', () => {
    it('counts cues per page label and keeps the last text', () => {
        const { module } = makeModule();
        module.buildPipeline({ pages: [{ page: 888, language: 'eng' }] });
        (module as any).onPluginEvent('subtitle:cue', {
            label: 'eng 888',
            text: 'Hello\nWorld',
            count: 1,
        });
        (module as any).onPluginEvent('subtitle:cue', { label: 'eng 888', text: '', count: 2 });
        (module as any).onPluginEvent('other:channel', { label: 'eng 888', text: 'ignored' });
        expect((module as any).setStatusData).toHaveBeenLastCalledWith('cues', {
            pages: 'eng 888 (2)',
            total: 2,
            last: 'eng 888: Hello / World',
        });
    });

    it('reports pages beyond the 8-decoder cap', () => {
        const { module } = makeModule();
        module.buildPipeline({
            pages: Array.from({ length: 10 }, (_, i) => ({ page: 100 + i })),
        });
        expect((module as any).setStatusData).toHaveBeenCalledWith(
            'cues',
            expect.objectContaining({ pages: expect.stringContaining('limit 8, 2 not decoded') }),
        );
    });
});

describe('detected pages', () => {
    // teletext descriptor: eng 888 subtitles + nor 692 subtitles
    const TTX_ES = '560a' + '656e671088' + '6e6f721692';
    const pmt = {
        pcrPid: 0x65,
        streams: [
            { pid: 0x65, streamType: 0x1b, esInfo: '' },
            { pid: 0x20, streamType: 0x06, esInfo: TTX_ES },
        ],
    };

    it('persists the announced list once, offers it as pick-list options and status', () => {
        const { module } = makeModule();
        (module as any).config = { pages: [], detectedPages: [] };
        module.buildPipeline((module as any).config);
        (module as any).onPluginEvent('tsprobe:pmt', pmt);
        expect((module as any).emitConfigUpdate).toHaveBeenCalledTimes(1);
        expect((module as any).config.discoveredPages).toEqual([
            { page: 692, language: 'nor', type: 2 },
            { page: 888, language: 'eng', type: 2 },
        ]);
        expect((module as any).setFieldOptions).toHaveBeenLastCalledWith('announcedPages', [
            { value: '692', label: '692 nor · subtitles' },
            { value: '888', label: '888 eng · subtitles' },
        ]);
        expect((module as any).setStatusData).toHaveBeenLastCalledWith('detected', {
            pages: '692 nor · subtitles, 888 eng · subtitles',
        });
        // same PMT again: no redundant persist
        (module as any).onPluginEvent('tsprobe:pmt', pmt);
        expect((module as any).emitConfigUpdate).toHaveBeenCalledTimes(1);
        // a PMT without teletext clears the list
        (module as any).onPluginEvent('tsprobe:pmt', { streams: pmt.streams.slice(0, 1) });
        expect((module as any).config.discoveredPages).toEqual([]);
        expect((module as any).setStatusData).toHaveBeenLastCalledWith('detected', {
            pages: 'none announced in the PMT',
        });
    });

    it('republishes the persisted list on start, before the first PMT', () => {
        const { module } = makeModule();
        (module as any).config = {
            pages: [],
            detectedPages: ['888'],
            discoveredPages: [{ page: 888, language: 'eng', type: 2 }],
        };
        module.buildPipeline((module as any).config);
        expect((module as any).setFieldOptions).toHaveBeenCalledWith('announcedPages', [
            { value: '888', label: '888 eng · subtitles' },
        ]);
        expect((module as any).emitConfigUpdate).not.toHaveBeenCalled();
    });
});
