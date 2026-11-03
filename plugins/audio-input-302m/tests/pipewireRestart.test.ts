import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** B-195 on a real PipeWire: a private daemon and pipewire-pulse (own runtime dir, no D-Bus, ALSA or
 *  WirePlumber), the real Audio Input (302M) on the native runner, real pactl and pw-link. Skipped,
 *  saying why, where PipeWire, its GStreamer plugin, the elements or the runner are missing. */

import { GstChildProcess, ModuleInstance, PipeWireManager } from '@media-router/engine';
import { setLogTap } from '@media-router/shared-types';
import {
    PrivatePipeWire,
    realPipeWireSkip,
    sleep,
    until,
} from '../../../packages/engine/src/audio/testing/privatePipeWire.js';
import { AudioInput302mModule } from '../engine/AudioInput302mModule.js';

const DEVICE = 'c18_mic';
const ELEMENTS = ['pipewiresrc', 'avenc_s302m', 'mpegtsmux', 'level', 'capssetter'];

/** Never the user's registry: the gate's own, or one of this run's. */
const registry = process.env.GST_REGISTRY ?? join(tmpdir(), `mr-b195-registry-${process.pid}.bin`);

const skip = realPipeWireSkip(ELEMENTS, registry);

beforeAll(() => {
    if (skip) console.warn(`[B-195] real PipeWire restart test skipped — ${skip}`);
});

describe.skipIf(skip !== null)(
    'Audio Input (302M) on a real PipeWire that restarts (B-195)',
    { timeout: 120_000 },
    () => {
        let pw: PrivatePipeWire;
        let instance: ModuleInstance;
        let module: AudioInput302mModule;
        const readings: number[] = [];
        const lines: Array<{ time: string; name: string; msg: string }> = [];
        /** Meter readings in the last `ms`: the capture delivers (silence included). */
        const flowing = (ms = 2000) => readings.filter((t) => Date.now() - t < ms).length >= 2;
        const state = () => module.getState();

        beforeAll(async () => {
            pw = new PrivatePipeWire({ sources: [DEVICE] });
            pw.enter(registry);
            setLogTap((l) => lines.push(JSON.parse(l)));
            await pw.start();
            module = new AudioInput302mModule();
            module.on('vuData', () => readings.push(Date.now()));
            instance = new ModuleInstance(
                'b195-mic',
                'audio-input-302m',
                module,
                { device: DEVICE, channels: 2 },
                {
                    instanceId: 'b195-mic',
                    pipeWire: new PipeWireManager(),
                    mediaRouter: {
                        assignBusChannel: () => ({ port: 41950 }),
                        releaseAllBusChannelsFor: () => {},
                        onProducerPlaying: () => {},
                        getModuleBusSources: () => [],
                        hasStoredEdge: () => false,
                    },
                    processManager: { releaseAll: async () => {} },
                    deviceProviders: {},
                } as any,
            );
            await instance.start();
            expect(await until(() => flowing() && state().health === 'ok', 60_000)).toBe(true);
        }, 120_000);

        afterAll(async () => {
            await instance?.stop();
            await pw?.stop();
            pw?.remove();
            setLogTap(null);
            pw?.leave();
            if (!process.env.GST_REGISTRY_KEEP && registry.includes('mr-b195-registry-')) {
                rmSync(registry, { force: true });
            }
        }, 60_000);

        it('restarted under the capture (~0.2 s down): a warning naming it, then capturing again within 10 s', async () => {
            expect(pw.hasNode('MR_PW_b195-mic')).toBe(true);
            await pw.stop();
            await sleep(200);
            await pw.start();
            const back = Date.now();
            expect(pw.hasNode('MR_PW_b195-mic')).toBe(false); // the field's after-1.txt
            const warned = until(() => state().health === 'warning', 10_000);
            expect(await warned).toBe(true);
            expect(state().error).toMatch(/^PipeWire restarted — rebuilding the stream/);
            expect(await until(() => flowing() && state().health === 'ok', 10_000)).toBe(true);
            console.log(
                `[B-195] restart: capturing again ${Date.now() - back} ms after PipeWire returned`,
            );
            expect(Date.now() - back).toBeLessThan(10_000);
            expect(pw.hasNode('MR_PW_b195-mic')).toBe(true);
        });

        it('stopped 20 s: one teardown, no rebuild and no log line while down, capturing again within 10 s of its return', async () => {
            const starts = vi.spyOn(GstChildProcess.prototype, 'start');
            await pw.stop();
            expect(await until(() => state().health === 'warning', 10_000)).toBe(true);
            expect(state().error).toMatch(/^PipeWire is not answering — rebuilding the stream/);
            const quiet = lines.length;
            const stderr = vi.spyOn(process.stderr, 'write');
            await sleep(15_000);
            expect(starts).not.toHaveBeenCalled();
            expect(lines.slice(quiet).map((l) => `${l.name}: ${l.msg}`)).toEqual([]);
            // Nor pactl's own complaint, once per call, into the engine's stderr (the journal).
            expect(
                stderr.mock.calls
                    .map((c) => String(c[0]))
                    .filter((t) => /Connection (failure|refused)/.test(t)),
            ).toEqual([]);
            stderr.mockRestore();
            await pw.start();
            const back = Date.now();
            expect(await until(() => flowing() && state().health === 'ok', 10_000)).toBe(true);
            console.log(
                `[B-195] outage: capturing again ${Date.now() - back} ms after PipeWire returned`,
            );
            expect(Date.now() - back).toBeLessThan(10_000);
            expect(starts).toHaveBeenCalledTimes(1);
            starts.mockRestore();
        });
    },
);
