import { describe, it, expect, vi } from 'vitest';
import type { PaCommandQueue } from './PaCommandQueue.js';
import { PA_VOLUME_NORM } from './AudioDeviceOps.js';
import type { AudioDevice } from './PipeWireManager.js';
import { SinkVolumeNormalizer } from './SinkVolumeNormalizer.js';

function makeQueue(impl: () => Promise<string> = () => Promise.resolve('')) {
    const exec = vi.fn(impl);
    return { queue: { exec } as unknown as PaCommandQueue, exec };
}

function dev(over: Partial<AudioDevice>): AudioDevice {
    return {
        id: 0,
        name: 'alsa_output.usb-shure',
        description: 'Shure MVX2U',
        direction: 'sink',
        volumes: [PA_VOLUME_NORM, PA_VOLUME_NORM],
        ...over,
    };
}

describe('SinkVolumeNormalizer', () => {
    it('resets an attenuated sink to unity in raw PA units', () => {
        const { queue, exec } = makeQueue();
        new SinkVolumeNormalizer(queue).normalize([dev({ volumes: [26214, 26214] })]);
        expect(exec).toHaveBeenCalledWith(['set-sink-volume', 'alsa_output.usb-shure', '65536']);
    });

    it('leaves a sink already at unity alone', () => {
        const { queue, exec } = makeQueue();
        new SinkVolumeNormalizer(queue).normalize([dev({})]);
        expect(exec).not.toHaveBeenCalled();
    });

    it('resets when only one channel is off unity — a balance offset attenuates too', () => {
        const { queue, exec } = makeQueue();
        new SinkVolumeNormalizer(queue).normalize([dev({ volumes: [PA_VOLUME_NORM, 26214] })]);
        expect(exec).toHaveBeenCalledTimes(1);
    });

    it('resets a sink boosted above unity — software owns gain in both directions', () => {
        const { queue, exec } = makeQueue();
        new SinkVolumeNormalizer(queue).normalize([dev({ volumes: [98304, 98304] })]);
        expect(exec).toHaveBeenCalledTimes(1);
    });

    it('ignores sources — the fix is scoped to sinks', () => {
        const { queue, exec } = makeQueue();
        new SinkVolumeNormalizer(queue).normalize([
            dev({ direction: 'source', volumes: [26214, 26214] }),
        ]);
        expect(exec).not.toHaveBeenCalled();
    });

    it('ignores devices with no parsed volume rather than assuming attenuation', () => {
        const { queue, exec } = makeQueue();
        const norm = new SinkVolumeNormalizer(queue);
        norm.normalize([dev({ volumes: [] }), dev({ name: 'b', volumes: undefined })]);
        expect(exec).not.toHaveBeenCalled();
    });

    it('does not stack a second reset while the first is still in flight', () => {
        let release!: () => void;
        const { queue, exec } = makeQueue(() => new Promise<string>((r) => {
            release = () => r('');
        }));
        const norm = new SinkVolumeNormalizer(queue);
        const devices = [dev({ volumes: [26214, 26214] })];
        norm.normalize(devices);
        norm.normalize(devices);
        expect(exec).toHaveBeenCalledTimes(1);
        release();
    });

    it('retries on the next poll once a failed reset has settled', async () => {
        const { queue, exec } = makeQueue(() => Promise.reject(new Error('pactl failed')));
        const norm = new SinkVolumeNormalizer(queue);
        const devices = [dev({ volumes: [26214, 26214] })];
        norm.normalize(devices);
        await vi.waitFor(() => expect(exec).toHaveBeenCalledTimes(1));
        // Let the rejection handler clear the in-flight marker.
        await new Promise((r) => setTimeout(r, 0));
        norm.normalize(devices);
        expect(exec).toHaveBeenCalledTimes(2);
    });

    it('normalizes every attenuated sink in one pass', () => {
        const { queue, exec } = makeQueue();
        new SinkVolumeNormalizer(queue).normalize([
            dev({ name: 'a', volumes: [26214, 26214] }),
            dev({ name: 'b', volumes: [PA_VOLUME_NORM, PA_VOLUME_NORM] }),
            dev({ name: 'c', volumes: [32768] }),
        ]);
        expect(exec.mock.calls.map((c) => c[0][1])).toEqual(['a', 'c']);
    });
});
