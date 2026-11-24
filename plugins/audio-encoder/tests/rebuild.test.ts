import { describe, it, expect, vi, afterEach } from 'vitest';
import { fakeOwnPipeWire } from '../../../packages/engine/src/audio/testing/fakeOwnPipeWire.js';
import { AudioEncoderModule } from '../engine/AudioEncoderModule.js';

const base = Object.getPrototypeOf(AudioEncoderModule.prototype);

/** v104 F3/F4: the Audio Encoder's rebuild after a PipeWire restart. */
describe('AudioEncoderModule rebuild (v104 F3, F4)', () => {
    afterEach(() => vi.restoreAllMocks());

    function make() {
        const pw = fakeOwnPipeWire();
        const m = new AudioEncoderModule() as any;
        m.services = {
            instanceId: 'enc',
            pipeWire: pw,
            mediaRouter: { getBusChannel: () => ({ port: 40100 }) },
        };
        m.config = { codec: 'opus', channels: 2, sampleRate: 48000 };
        vi.spyOn(base, 'onStop').mockResolvedValue(undefined);
        return { pw, m };
    }

    it('a rebuild whose pipeline fails to start, then one that does: its null sink once', async () => {
        const { pw, m } = make();
        vi.spyOn(base, 'onStart')
            .mockRejectedValueOnce(new Error('start failed'))
            .mockResolvedValue(undefined);
        await expect(m.onDeviceReconnected()).rejects.toThrow('start failed');
        await m.onDeviceReconnected();
        expect(pw.counts()).toEqual({ MR_PW_enc: 1 });
    });

    it('publishes its encoder and bus cards again after a rebuild (F4)', async () => {
        const { m } = make();
        vi.spyOn(base, 'onStart').mockResolvedValue(undefined);
        const cards = vi.spyOn(m, 'setStatusData');
        await m.onDeviceReconnected();
        const ids = cards.mock.calls.map((c) => c[0]);
        expect(ids).toEqual(expect.arrayContaining(['encoder', 'bus']));
    });
});
