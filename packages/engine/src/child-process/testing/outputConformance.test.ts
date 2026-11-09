import { describe, expect, it, vi } from 'vitest';
import { GstChildProcess } from '../GstChildProcess.js';
import { launchWith } from '../busSocketGate.js';
import type { RunnerStartOptions } from '../PythonProcess.js';
import type { PipelineDescription } from '../../plugins/PluginModule.js';
import { AudioDecoderModule } from '../../../../../plugins/audio-decoder/engine/AudioDecoderModule.js';
import { AudioOutput302mModule } from '../../../../../plugins/audio-output-302m/engine/AudioOutput302mModule.js';
import { MpegTsMuxerModule } from '../../../../../plugins/mpegts-muxer/engine/MpegTsMuxerModule.js';
import { TranscoderModule } from '../../../../../plugins/transcoder/engine/TranscoderModule.js';
import { selectDecoder } from '../../../../../plugins/video-player/engine/helpers/decoderSelection.js';
import {
    planLivePipeline,
    planSink,
} from '../../../../../plugins/video-player/engine/helpers/pipelinePlan.js';
import type { RenderTargetReady } from '../../../../../plugins/video-player/engine/helpers/renderTarget.js';

/**
 * The runner commands output_conformance_test.py replays (plan ch. 8 WI-P4-14), made by the real
 * modules: `fixtures/output/pipelines.json`, rewritten by `vitest -u`. `@SOCK@` stands for the
 * harness's socket directory; modules are handled as plain objects, as in alignerConformance.test.ts.
 */

const SOCK = '@SOCK@';
const FIXTURE = '../../../../../plugins/mpegts-core/tests/fixtures/output/pipelines.json';

const TARGET: RenderTargetReady = {
    kind: 'ready',
    active: { name: 'HDMI-A-1', connectorId: 32, substituted: false },
    sinkEnv: { wayland: false, kms: true, waylandSession: false, connectorId: 32 },
    renderConnector: 'HDMI-A-1',
    waylandFullscreen: false,
    env: {},
};

/** What GstChildProcess sends for `desc`, its live inputs linked in as the runner host launches
 *  it; `env` applies at spawn and the restart knobs stay in Node. */
function startCommand(desc: PipelineDescription | null) {
    expect(desc).not.toBeNull();
    const payload = (
        new GstChildProcess() as unknown as {
            startPayload(d: PipelineDescription): Record<string, unknown>;
        }
    ).startPayload(desc!);
    const { env, restartOnError: _r, restartBackoffMs: _b, runner, ...cmd } = payload;
    const opts = cmd as unknown as RunnerStartOptions;
    const launched = opts.liveInputs?.length ? launchWith(opts, opts.liveInputs) : opts;
    const start: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(launched)) if (v !== undefined) start[k] = v;
    return { start, env: env ?? {}, runner: runner ?? null };
}

function source(name: string, port: number, sinkPortId: string, streamType: string) {
    return {
        port,
        connectionId: `conn-${name}`,
        sourceModuleId: `mod-${name}`,
        sourcePortId: 'out',
        sinkPortId,
        streamType,
        socketPath: `${SOCK}/${name}.sock`,
    };
}

/** The video player's live string on a KMS connector at `refreshHz`, its explicit rung for `codec`
 *  in software (the dev Pi's). */
function player(codec: 'h264' | 'h265', refreshHz: number) {
    const decoder = selectDecoder({
        codec,
        available: { h264parse: true, avdec_h264: true, h265parse: true, avdec_h265: true },
    });
    expect(decoder.explicit).toBe(true);
    return startCommand(
        planLivePipeline({
            sinkElement: planSink(TARGET).sinkElement,
            udpSource: { port: 40500, socketPath: `${SOCK}/vp.sock` },
            env: TARGET.env,
            waylandFullscreen: TARGET.waylandFullscreen,
            decoder,
            cpuDecodeThreading: undefined,
            refreshHz,
        }),
    );
}

/** audio-decoder on one edge, its AAC branch (the generated streams' audio). */
function decoder() {
    const m = new AudioDecoderModule() as unknown as Record<string, unknown>;
    m.services = {
        instanceId: 'adec',
        mediaRouter: { getModuleBusSource: () => source('ad', 40420, 'mpegts-in', 'muxed/mpegts') },
    };
    m.probeResult = { codec: 'aac', rawCaps: '' };
    m.setHealth = vi.fn();
    return startCommand((m.buildPipeline as (c: unknown) => PipelineDescription | null)({}));
}

/** audio-output-302m on one 302M edge (its single-source arm). */
function aout302m() {
    const m = new AudioOutput302mModule() as unknown as Record<string, unknown>;
    m.services = {
        instanceId: 'aout',
        mediaRouter: { getModuleBusSources: () => [source('ao', 40410, 'audio-in', 'audio/302m')] },
    };
    m.setHealth = vi.fn();
    m.setStatusData = vi.fn();
    return startCommand(
        (m.buildPipeline as (c: unknown) => PipelineDescription | null)({ device: 'alsa_output.test' }),
    );
}

/** mpegts-muxer with one TS input (H.264 + AAC), the outputs on its bus tee. */
function muxer() {
    const m = new MpegTsMuxerModule() as unknown as Record<string, unknown>;
    const config = { inputs: [{}] };
    m.services = {
        instanceId: 'mux1',
        mediaRouter: {
            getModuleBusSources: () => [source('mx0', 40300, 'input-0', 'muxed/mpegts')],
            assignBusChannel: () => ({ port: 41050 }),
        },
    };
    m.config = config;
    m.setHealth = vi.fn();
    m.setStatusData = vi.fn();
    m.setDynamicSections = vi.fn();
    m.emitConfigUpdate = vi.fn();
    return startCommand((m.buildPipeline as (c: unknown) => PipelineDescription | null)(config));
}

/** The Video Transcoder's burn-in: a 25 fps source, one small rendition, the cues on subtitles-in. */
function burnin() {
    const arch = Object.getOwnPropertyDescriptor(process, 'arch')!;
    Object.defineProperty(process, 'arch', { ...arch, value: 'arm64' });
    TranscoderModule.setHwScalers({ va: false, v4l2: false });
    TranscoderModule.setAvailableImpls({ h264: ['software'], h265: ['software'], av1: ['software'] });
    try {
        const m = new TranscoderModule() as unknown as Record<string, unknown>;
        let port = 41060;
        m.services = {
            instanceId: 'tc',
            mediaRouter: {
                getModuleBusSource: (_id: string, portId?: string) =>
                    portId === 'subtitles-in'
                        ? { port: 40601, socketPath: `${SOCK}/subs.sock` }
                        : { port: 40600, socketPath: `${SOCK}/video.sock` },
                assignBusChannel: () => ({ port: port++ }),
            },
        };
        m.setHealth = vi.fn();
        m.setStatusData = vi.fn();
        m.setBadge = vi.fn();
        return startCommand(
            (m.buildPipeline as (c: unknown) => PipelineDescription | null)({
                framerate: 25,
                gopFrames: 25,
                renditions: [{ name: '180p', width: 320, height: 180, bitrate: 300 }],
            }),
        );
    } finally {
        Object.defineProperty(process, 'arch', arch);
    }
}

describe('the output conformance runner commands', () => {
    it('fixtures/output/pipelines.json is what the modules make (`vitest -u` rewrites it)', async () => {
        const out = {
            player50: player('h264', 50),
            player60: player('h264', 60),
            playerHevc: player('h265', 50),
            decoder: decoder(),
            aout302m: aout302m(),
            mux1: muxer(),
            burnin: burnin(),
        };
        // What the harness swaps and watches is there, by name (WI-P4-5, WI-P4-13).
        for (const p of [out.player50, out.player60, out.playerHevc]) {
            const s = String(p.start.pipeline);
            expect(s).toMatch(/queue name=vp_esq leaky=0 /);
            expect(s).toMatch(/mrvideopace name=vp_pace /);
            expect(s).toMatch(/kmssink name=sink [^!]*sync=false/);
        }
        expect(String(out.decoder.start.pipeline)).toMatch(/queue name=ad_esq leaky=0 .* queue name=prefill /);
        expect(String(out.aout302m.start.pipeline)).toMatch(/queue name=prefill .*pulsesink name=sink /);
        expect(String(out.burnin.start.pipeline)).toMatch(/mralignwatch name=aw_burnv aligner=burnin /);
        expect(out.burnin.runner).toBe('python');
        await expect(`${JSON.stringify(out, null, 2)}\n`).toMatchFileSnapshot(FIXTURE);
    });
});
