import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** v104 B1 on a real PipeWire: the N-1 Mixer makes its own null sinks at its start, and a PipeWire
 *  restart takes them with it; da3c769c never made them again (no watchdog). It comes back as the
 *  Audio Decoder does since 26ef69fd: its own nodes made again, its streams on them, its pw-links
 *  re-made. Skipped, saying why, without PipeWire, an element, the plugin or the runner. */

import {
    monitorRead,
    ownNodeRig,
    restartComesBack,
    streamInto,
    type OwnNodeRig,
} from '../../../packages/engine/src/audio/testing/ownNodeRig.js';
import { realPipeWireSkip } from '../../../packages/engine/src/audio/testing/privatePipeWire.js';
import { N1MixerModule } from '../engine/N1MixerModule.js';

const ID = 'b1-n1';
const PLUGINS = process.env.MR_PLUGINS_DIR ?? join(__dirname, '../..');
const TIMING_PLUGIN = join(PLUGINS, 'mpegts-core/native/mrtshouse/libgstmrtshouse.so');
const registry = process.env.GST_REGISTRY ?? join(tmpdir(), `mr-v104b1-b1-n1-${process.pid}.bin`);
const skip = existsSync(TIMING_PLUGIN)
    ? realPipeWireSkip(['pulsesrc'], registry)
    : 'the timing plugin is not built (libgstmrtshouse.so)';

beforeAll(() => {
    if (skip) console.warn(`[v104 B1] real PipeWire restart test (N-1 Mixer) skipped — ${skip}`);
});

describe.skipIf(skip !== null)(
    'N-1 Mixer on a real PipeWire that restarts (v104 B1)',
    { timeout: 120_000 },
    () => {
        let rig: OwnNodeRig;
        const SINKS = [
            'MR_PW_b1-n1_in_0',
            'MR_PW_b1-n1_in_1',
            'MR_PW_b1-n1_out_0',
            'MR_PW_b1-n1_out_1',
        ];
        void streamInto;
        void monitorRead;

        beforeAll(async () => {
            rig = await ownNodeRig({
                registry,
                id: ID,
                pluginId: 'n1-mixer',
                module: new N1MixerModule() as any,
                config: { pairCount: 2 },
            });
        }, 90_000);

        afterAll(async () => {
            await rig?.stop();
            if (!process.env.GST_REGISTRY_KEEP && registry.includes('mr-v104b1-'))
                rmSync(registry, { force: true });
        }, 60_000);

        it('restarted (~0.2 s down): a warning, its own nodes and streams back within 15 s, its pw-links re-made', async () => {
            const ready = async () =>
                (await monitorRead(rig.pw, 'MR_PW_b1-n1_in_0')) &&
                (await monitorRead(rig.pw, 'MR_PW_b1-n1_in_1')) &&
                (await streamInto(rig.pw, 'MR_PW_b1-n1_out_0')) &&
                (await streamInto(rig.pw, 'MR_PW_b1-n1_out_1'));
            const { ms, health } = await restartComesBack(rig, SINKS, ready);
            console.log(
                `[v104 B1] N-1 Mixer: back ${ms} ms after PipeWire returned (health ${health.join(',')})`,
            );
            expect(rig.lines.map((l) => l.msg)).toContain('PipeWire stream rebuilt');
            expect(rig.relinkIn).toHaveBeenCalledWith(ID);
            expect(rig.relinkOut).toHaveBeenCalledWith(ID);
        });
    },
);
