import { describe, it, expect, vi, afterEach } from 'vitest';
import { fakeOwnPipeWire } from '../../../packages/engine/src/audio/testing/fakeOwnPipeWire.js';
import { AudioDecoderModule } from '../engine/AudioDecoderModule.js';

const base = Object.getPrototypeOf(AudioDecoderModule.prototype);

/** v104 F3: the Audio Decoder's rebuild after a PipeWire restart. */
describe('AudioDecoderModule rebuild (v104 F3)', () => {
    afterEach(() => vi.restoreAllMocks());

    it('a rebuild whose pipeline fails to start, then one that does: its null sink once', async () => {
        const pw = fakeOwnPipeWire();
        const m = new AudioDecoderModule() as any;
        m.services = { instanceId: 'dec', pipeWire: pw, mediaRouter: {} };
        m.config = {};
        Object.defineProperty(m, 'pwNodeName', { value: 'MR_PW_dec', configurable: true });
        vi.spyOn(base, 'onStop').mockResolvedValue(undefined);
        vi.spyOn(base, 'onStart')
            .mockRejectedValueOnce(new Error('start failed'))
            .mockResolvedValue(undefined);
        await expect(m.onDeviceReconnected()).rejects.toThrow('start failed');
        await m.onDeviceReconnected();
        expect(pw.counts()).toEqual({ MR_PW_dec: 1 });
    });
});
