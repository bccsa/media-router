import { describe, it, expect, vi, beforeEach } from 'vitest';

const execFileMock = vi.fn();
vi.mock('child_process', () => ({
    execFile: (...args: unknown[]) => execFileMock(...args),
}));

import { gstInspectMaxChannels, probeGstElement } from './gstInspect.js';

type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void;

function callBack(cb: ExecCallback, err: Error | null, stdout = '') {
    setTimeout(() => cb(err, stdout, ''), 0);
}

describe('probeGstElement', () => {
    beforeEach(() => {
        execFileMock.mockReset();
    });

    it('resolves true when gst-inspect-1.0 exits 0', async () => {
        execFileMock.mockImplementation((_cmd, _args, _opts, cb: ExecCallback) =>
            callBack(cb, null),
        );
        await expect(probeGstElement('opusenc-unique-1')).resolves.toBe(true);
    });

    it('resolves false when gst-inspect-1.0 exits non-zero', async () => {
        execFileMock.mockImplementation((_cmd, _args, _opts, cb: ExecCallback) =>
            callBack(cb, new Error('exit 1')),
        );
        await expect(probeGstElement('nonexistent-element-2')).resolves.toBe(false);
    });

    it('caches the result so a second call does not re-invoke gst-inspect', async () => {
        execFileMock.mockImplementation((_cmd, _args, _opts, cb: ExecCallback) =>
            callBack(cb, null),
        );
        await probeGstElement('cached-element-3');
        await probeGstElement('cached-element-3');
        await probeGstElement('cached-element-3');
        expect(execFileMock).toHaveBeenCalledTimes(1);
    });
});

describe('gstInspectMaxChannels', () => {
    beforeEach(() => {
        execFileMock.mockReset();
    });

    it('parses the smallest "channels: [ 1, N ]" range from gst-inspect output', async () => {
        const stdout = `
Pad Templates:
  SRC template: 'src'
    Capabilities:
      audio/x-opus
                 rate: { (int)8000, (int)12000 }
             channels: [ 1, 8 ]

  SINK template: 'sink'
    Capabilities:
      audio/x-raw
                 rate: { (int)8000, (int)16000 }
             channels: [ 1, 2 ]
`;
        execFileMock.mockImplementation((_cmd, _args, _opts, cb: ExecCallback) =>
            callBack(cb, null, stdout),
        );
        await expect(gstInspectMaxChannels('opusenc')).resolves.toBe(2);
    });

    it('takes the larger range when only one is present', async () => {
        const stdout = 'channels: [ 1, 6 ]';
        execFileMock.mockImplementation((_cmd, _args, _opts, cb: ExecCallback) =>
            callBack(cb, null, stdout),
        );
        await expect(gstInspectMaxChannels('avenc_aac')).resolves.toBe(6);
    });

    it('falls back to 2 when the element is missing (gst-inspect errors)', async () => {
        execFileMock.mockImplementation((_cmd, _args, _opts, cb: ExecCallback) =>
            callBack(cb, new Error('No such element')),
        );
        await expect(gstInspectMaxChannels('does-not-exist')).resolves.toBe(2);
    });

    it('falls back to 2 when the output declares no channel range', async () => {
        execFileMock.mockImplementation((_cmd, _args, _opts, cb: ExecCallback) =>
            callBack(cb, null, 'unrelated output, no channels declaration'),
        );
        await expect(gstInspectMaxChannels('weird-element')).resolves.toBe(2);
    });
});
