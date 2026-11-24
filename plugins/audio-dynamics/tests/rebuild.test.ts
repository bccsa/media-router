import { describe, it, expect, vi, afterEach } from 'vitest';
import { fakeOwnPipeWire } from '../../../packages/engine/src/audio/testing/fakeOwnPipeWire.js';
import { AudioDynamicsModule } from '../engine/AudioDynamicsModule.js';

const base = Object.getPrototypeOf(AudioDynamicsModule.prototype);

/** v104 F3/F4: Audio Dynamics' rebuild after a PipeWire restart. */
describe('AudioDynamicsModule rebuild (v104 F3, F4)', () => {
    afterEach(() => vi.restoreAllMocks());

    function make() {
        const pw = fakeOwnPipeWire();
        const m = new AudioDynamicsModule() as any;
        m.services = { instanceId: 'dyn', pipeWire: pw, mediaRouter: {} };
        m.config = { mode: 'ducker' };
        vi.spyOn(base, 'onStop').mockResolvedValue(undefined);
        const watch = vi.spyOn(m.timing, 'watchPipeWire').mockImplementation(() => {});
        return { pw, m, watch };
    }

    it('a rebuild failing at its second sink, then one that succeeds: each sink once', async () => {
        const { pw, m } = make();
        vi.spyOn(base, 'onStart').mockResolvedValue(undefined);
        pw.state.failLoadAt = 1;
        await expect(m.onDeviceReconnected()).rejects.toThrow('load failed');
        await m.onDeviceReconnected();
        expect(pw.counts()).toEqual({ MR_PW_dyn_prog: 1, MR_PW_dyn_sc: 1, MR_PW_dyn_out: 1 });
    });

    it('a rebuild whose pipeline fails to start, then one that does: each sink once', async () => {
        const { pw, m } = make();
        vi.spyOn(base, 'onStart')
            .mockRejectedValueOnce(new Error('start failed'))
            .mockResolvedValue(undefined);
        await expect(m.onDeviceReconnected()).rejects.toThrow('start failed');
        await m.onDeviceReconnected();
        expect(pw.counts()).toEqual({ MR_PW_dyn_prog: 1, MR_PW_dyn_sc: 1, MR_PW_dyn_out: 1 });
    });

    it('re-arms its PipeWire timing watch after a rebuild (F4)', async () => {
        const { m, watch } = make();
        vi.spyOn(base, 'onStart').mockResolvedValue(undefined);
        await m.onDeviceReconnected();
        expect(watch).toHaveBeenCalledWith(['MR_PW_dyn_out']);
    });
});
