import { describe, expect, it } from 'vitest';
import { GstChildProcess } from '../GstChildProcess.js';
import { LatenessReporter } from '../../plugins/latenessReporter.js';
import type { PipelineDescription } from '../../plugins/PluginModule.js';
import {
    DECODEBIN_SELECTION,
    selectDecoder,
    type DecoderSelection,
} from '../../../../../plugins/video-player/engine/helpers/decoderSelection.js';
import {
    planLivePipeline,
    planSink,
    videoTsOffsetNs,
} from '../../../../../plugins/video-player/engine/helpers/pipelinePlan.js';
import type { RenderTargetReady } from '../../../../../plugins/video-player/engine/helpers/renderTarget.js';

/**
 * The video player's start commands protocol case video-leg-formula runs (WI-P3-11), from its own
 * plan on a KMS connector at the default D: `fixtures/video-leg/pipelines.json`, by `vitest -u`.
 */

const SOCK = '@SOCK@';
const FIXTURE = '../../../../../plugins/mpegts-core/tests/fixtures/video-leg/pipelines.json';

const TARGET: RenderTargetReady = {
    kind: 'ready',
    active: { name: 'HDMI-A-1', connectorId: 32, substituted: false },
    sinkEnv: { wayland: false, kms: true, waylandSession: false, connectorId: 32 },
    renderConnector: 'HDMI-A-1',
    waylandFullscreen: false,
    env: {},
};

/** What the engine sends for one rung, as alignerConformance.test.ts takes it. */
function startCommand(decoder: DecoderSelection) {
    const sink = planSink(TARGET, {}, videoTsOffsetNs(null, {}));
    const desc = planLivePipeline({
        sinkElement: sink.sinkElement,
        udpSource: { port: 40500, socketPath: `${SOCK}/vp.sock` },
        env: TARGET.env,
        waylandFullscreen: TARGET.waylandFullscreen,
        decoder,
        bufferMs: undefined,
        cpuDecodeThreading: undefined,
        sinkPaced: sink.sinkPaced,
        services: null,
    });
    const payload = (
        new GstChildProcess() as unknown as {
            startPayload(d: PipelineDescription): Record<string, unknown>;
        }
    ).startPayload(desc);
    const { env: _e, restartOnError: _r, restartBackoffMs: _b, runner: _n, ...cmd } = payload;
    return Object.fromEntries(Object.entries(cmd).filter(([, v]) => v !== undefined));
}

describe('the video leg', () => {
    it('fixtures/video-leg/pipelines.json is what the player plans (`vitest -u` rewrites it)', async () => {
        // A Pi 5 has no H.264 hardware decoder: the explicit rung the dev Pi runs is software.
        const explicit = selectDecoder({
            codec: 'h264',
            available: { h264parse: true, avdec_h264: true },
        });
        expect(explicit.explicit).toBe(true);
        const out = {
            explicit: { start: startCommand(explicit) },
            bootstrap: { start: startCommand(DECODEBIN_SELECTION) },
        };
        await expect(`${JSON.stringify(out, null, 2)}\n`).toMatchFileSnapshot(FIXTURE);
    });

    it('an input without a video stream says so, in the words of the demux media', () => {
        const r = new LatenessReporter();
        r.configure(String(startCommand(DECODEBIN_SELECTION).pipeline));
        r.onEvent('mrtsdemux:vpdemux', { reason: 'no-stream', stream: 'missing' }, 0);
        expect(r.streamWarnings(0)).toEqual([
            { kind: 'input-no-stream', text: 'Input vpdemux carries no video stream' },
        ]);
    });
});
