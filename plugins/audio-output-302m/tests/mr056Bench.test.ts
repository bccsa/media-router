import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { liveInputLaunchText } from '@media-router/engine';
import { AudioOutput302mModule } from '../engine/AudioOutput302mModule.js';
import { AMP, launch, levelRigSkip, removeRigRegistry } from './levelRig.js';

/** MR-056's bench as a regression: tones, the branch's audioconvert and caps, the aligned mixer and
 *  its caps, the VU, the placement and a meter, all but the tones from the output's own launch
 *  text. On b9c24948 OUT1-4's shape (4 from 1, four sources mapped 1:1) read -350 dB on all four. */

/** The output's launch text for `channels` from `first` on a 32-channel card, each source's
 *  channel 1 mapped to its own mix channel. */
function outputText(channels: number, first: number, count: number): string {
    const module = new AudioOutput302mModule() as any;
    const sources = Array.from({ length: count }, (_, i) => ({
        port: 40100 + i,
        connectionId: `c-${i}`,
        sourceModuleId: `src-${i}`,
        sourcePortId: 'out-0',
        sinkPortId: 'audio-in',
        streamType: 'audio/302m',
        socketPath: `/tmp/mr-c35b-${i}.sock`,
        channelMap: [{ srcChannel: 0, dstChannel: i }],
    }));
    module.services = {
        instanceId: 'aout',
        mediaRouter: {
            getModuleBusSources: () => sources,
            getRoutePlayoutOffsetMs: () => undefined,
        },
    };
    module.config = {};
    module.deviceChannels = 32;
    module.setHealth = () => {};
    module.setStatusData = () => {};
    const desc = module.buildPipeline({ device: 'rigdev', channels, firstChannel: first });
    return [
        desc.pipeline,
        ...(desc.liveInputs ?? []).map((b: any, i: number) => liveInputLaunchText(b, i)),
    ].join(' ');
}

/** The bench: the tones in place of each decoded source (stereo, as avdec_s302m gives it). */
function bench(text: string, count: number): string {
    const mixer = /^audiomixer name=mixin [^!]*! capsfilter name=mixin_out caps="[^"]*"/.exec(text);
    const fragment = /interval=100000000 ! (.*?) ! pulsesink /.exec(text);
    if (!mixer || !fragment) throw new Error(`MR-056 bench: not the mixer arm: ${text}`);
    const branches = Array.from({ length: count }, (_, i) => {
        const tail = new RegExp(
            `mrasrc name=mixin_asrc_\\w+ [^!]*! (audioconvert[^!]*! [^!]*) ! mralignwatch [^)]*input="c-${i}"`,
        ).exec(text);
        if (!tail) throw new Error(`MR-056 bench: no branch ${i}`);
        return (
            `audiotestsrc is-live=true wave=sine freq=${300 + 200 * i} volume=${AMP}` +
            ` ! audio/x-raw,rate=48000,channels=2 ! ${tail[1]} ! mixin.sink_${i}`
        );
    });
    return (
        `${mixer[0]} mixin_out. ! level ! ${fragment[1]}` +
        ' ! level name=devlevel post-messages=true interval=100000000 ! fakesink sync=true ' +
        branches.join(' ')
    );
}

const skip = levelRigSkip();

beforeAll(() => {
    if (skip) console.warn(`[MR-056] bench skipped — ${skip}`);
});

afterAll(() => removeRigRegistry());

describe.skipIf(skip !== null)("MR-056's bench, from the output's own strings", () => {
    it('OUT1-4 (4 from 1 on a 32-channel card, four sources each on its channel): every source plays on its own channel', async () => {
        const text = bench(outputText(4, 1, 4), 4);
        const rms = (await launch(text, 3)).get('devlevel') ?? [];
        expect(rms.length).toBeGreaterThan(5);
        const last = rms[rms.length - 1];
        expect(last).toHaveLength(4);
        const ref = 20 * Math.log10(AMP / Math.SQRT2);
        for (const level of last) expect(Math.abs(level - ref)).toBeLessThan(0.5);
    }, 60_000);

    it('a 2-channel mix on channels 3–4 (the bench row that played on b9c24948) still plays there', async () => {
        const text = bench(outputText(2, 3, 2), 2);
        const rms = (await launch(text, 3)).get('devlevel') ?? [];
        expect(rms.length).toBeGreaterThan(5);
        const [one, two, three, four] = rms[rms.length - 1];
        const ref = 20 * Math.log10(AMP / Math.SQRT2);
        expect(Math.max(one, two)).toBeLessThan(-90);
        expect(Math.abs(three - ref)).toBeLessThan(0.5);
        expect(Math.abs(four - ref)).toBeLessThan(0.5);
    }, 60_000);
});
