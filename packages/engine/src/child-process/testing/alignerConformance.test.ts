import { describe, expect, it, vi } from 'vitest';
import { GstPluginBase } from '@media-router/engine';
import { GstChildProcess } from '../GstChildProcess.js';
import { annotateLiveInputBranches } from '../../plugins/liveInputBranches.js';
import type { PipelineDescription, PluginModule } from '../../plugins/PluginModule.js';
import { AudioMixerModule } from '../../../../../plugins/audio-mixer/engine/AudioMixerModule.js';
import { AudioProcessingModule } from '../../../../../plugins/audio-processing/engine/AudioProcessingModule.js';
import { MpegTsMuxerModule } from '../../../../../plugins/mpegts-muxer/engine/MpegTsMuxerModule.js';
import { buildSpawnArgs } from '../../../../../plugins/ts-splitter/engine/nativeRunner.js';

/**
 * The runner commands aligner_conformance_test.py and the protocol cases replay (plan ch. 6
 * WI-P2-14), made by the real modules: `fixtures/aligner/pipelines.json`, rewritten by
 * `vitest -u`. `@SOCK@` stands for the harness's socket directory. Modules are handled as plain
 * objects: the plugins' engine types come from its dist, this file's from its source.
 */

const SOCK = '@SOCK@';
const FIXTURE = '../../../../../plugins/mpegts-core/tests/fixtures/aligner/pipelines.json';

interface Source {
    port: number;
    connectionId: string;
    sourceModuleId: string;
    sourcePortId: string;
    sinkPortId: string;
    streamType: string;
    socketPath: string;
}

function source(name: string, port: number, sinkPortId: string, streamType = 'audio/302m'): Source {
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

/** A module on a fake router whose wired sources the caller swaps between builds. */
function wire(module: object, instanceId: string, outPort: number) {
    const state = { sources: [] as Source[] };
    const m = module as unknown as Record<string, unknown>;
    m.services = {
        instanceId,
        mediaRouter: {
            getModuleBusSources: () => state.sources,
            assignBusChannel: () => ({ port: outPort }),
        },
    };
    m.setHealth = vi.fn();
    m.setStatusData = vi.fn();
    m.setDynamicSections = vi.fn();
    m.emitConfigUpdate = vi.fn();
    return state;
}

/** What the engine sends: the module's description as GstPluginBase starts it, through
 *  GstChildProcess's own payload; `env` applies at spawn and the restart knobs stay in Node. */
function startCommand(module: object, built: unknown) {
    expect(built).not.toBeNull();
    const desc = built as PipelineDescription;
    const services = (module as { services: never }).services;
    annotateLiveInputBranches(module as PluginModule, services, desc);
    const payload = (
        new GstChildProcess() as unknown as {
            startPayload(d: PipelineDescription): Record<string, unknown>;
        }
    ).startPayload(desc);
    const { env, restartOnError: _r, restartBackoffMs: _b, runner: _n, ...cmd } = payload;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(cmd)) if (v !== undefined) out[k] = v;
    return { start: out, env };
}

function mixer(names: string[], outPort: number, basePort: number) {
    const module = new AudioMixerModule();
    const wired = wire(module, `mixer-${outPort}`, outPort);
    (module as unknown as { config: unknown }).config = { channels: 2 };
    AudioMixerModule.setS302mSupported(true);
    wired.sources = names.map((n, i) => source(n, basePort + i, 'audio-in'));
    return { module, wired };
}

async function ducker(outPort: number) {
    const module = new AudioProcessingModule();
    AudioProcessingModule.setS302mSupported(true);
    const config = { mode: 'ducker' };
    const sources = [source('prog', 40201, 'program-in'), source('key-ap', 40202, 'sidechain-in')];
    await module.onInit(config, {
        instanceId: 'ducker',
        mediaRouter: {
            getModuleBusSources: () => sources,
            assignBusChannel: () => ({ port: outPort }),
        },
    } as never);
    const m = module as unknown as Record<string, unknown>;
    m.setHealth = vi.fn();
    m.setStatusData = vi.fn();
    const superStart = vi.spyOn(GstPluginBase.prototype, 'onStart').mockResolvedValue(undefined);
    try {
        await module.onStart();
    } finally {
        superStart.mockRestore();
    }
    const cmd = startCommand(module, module.buildPipeline(config));
    await module.onStop();
    return cmd;
}

function muxer(name: string, outPort: number, config: Record<string, unknown>, inputs: number) {
    const module = new MpegTsMuxerModule();
    const wired = wire(module, `mux-${name}`, outPort);
    (module as unknown as { config: unknown }).config = config;
    wired.sources = Array.from({ length: inputs }, (_, i) =>
        source(`${name}${i}`, 40300 + i, `input-${i}`, 'muxed/mpegts'),
    );
    return startCommand(module, module.buildPipeline(config));
}

describe('the conformance runner commands', () => {
    it('fixtures/aligner/pipelines.json is what the modules make (`vitest -u` rewrites it)', async () => {
        // audio-mixer, three sources (absent-rejoin, late-delivering, wrap, aligner-absent).
        const m3 = mixer(['in0', 'in1', 'in2'], 41010, 40100);
        const mixer3 = startCommand(m3.module, m3.module.buildPipeline({ channels: 2 }));

        // audio-mixer, two sources, then a third added live and removed (slow joiner, case L).
        const m2 = mixer(['in0', 'in1'], 41011, 40110);
        const mixer2 = startCommand(m2.module, m2.module.buildPipeline({ channels: 2 }));
        const joiner = source('in2', 40112, 'audio-in');
        m2.wired.sources = [...m2.wired.sources, joiner];
        const add = m2.module.getLiveInputBranch('audio-in', joiner.connectionId);
        m2.wired.sources = m2.wired.sources.slice(0, 2);
        const remove = m2.module.getLiveInputBranch('audio-in', joiner.connectionId);

        // #837: programme and key into audio-processing (ducker); its output and the key into a mixer.
        const duck = await ducker(41020);
        const m837 = mixer(['duck', 'key-mx'], 41021, 40210);
        const mixer837 = startCommand(m837.module, m837.module.buildPipeline({ channels: 2 }));

        // mpegts-muxer: synthetic video with cues (its AUs are no H.264, so no parser), then
        // real H.264 + AAC beside Opus.
        const muxKlv = muxer('klv', 41030, { inputs: [{}, {}], videoParserBypass: true }, 2);
        const muxBursty = muxer('burst', 41031, { inputs: [{}, {}] }, 2);

        // ts-splitter on the OCC capture: video (the PCR PID), one AAC PID, teletext.
        const splitter = buildSpawnArgs({
            inputSocketPath: `${SOCK}/split-in.sock`,
            tsId: 1,
            outputs: [
                { pid: 0x65, port: 41040, streamType: 0x1b },
                { pid: 0xc9, port: 41041, streamType: 0x0f },
                { pid: 0x20, port: 41042, streamType: 0x06 },
            ],
        });

        const out = {
            mixer3,
            mixer2: { ...mixer2, add, remove },
            ducker: duck,
            mixer837,
            muxKlv,
            muxBursty,
            splitter: { argv: splitter },
        };
        await expect(`${JSON.stringify(out, null, 2)}\n`).toMatchFileSnapshot(FIXTURE);
    });
});
