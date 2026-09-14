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
    return { module, getModuleBusSource, assignBusChannel };
}

describe('getDynamicPorts', () => {
    it('input + one output per page; provisional 888 before config lands', () => {
        const { module } = makeModule();
        (module as any).config = {};
        expect(module.getDynamicPorts().map((p) => p.id)).toEqual(['mpegts-in', 'page-0']);
        (module as any).config = { pages: [{ page: 888 }, { page: 692 }] };
        expect(module.getDynamicPorts().map((p) => p.id)).toEqual([
            'mpegts-in',
            'page-0',
            'page-1',
        ]);
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

    it('warns with an explicit empty page list', () => {
        const { module } = makeModule();
        expect(module.buildPipeline({ pages: [] })).toBeNull();
        expect((module as any).setHealth).toHaveBeenCalledWith(
            'warning',
            expect.stringContaining('No teletext pages'),
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
        expect(assignBusChannel).toHaveBeenCalledWith('ttx-1', 'page-0');
        expect(assignBusChannel).toHaveBeenCalledWith('ttx-1', 'page-1');
        expect(desc.restartOnError).toBe(true);
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
});
