import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BusFanoutCoordinator } from './BusFanoutCoordinator.js';
import { busEdgeSocketPath, busTeeName } from '../plugins/busHelpers.js';
import type { Connection } from './MediaRouter.js';

function conn(over: Partial<Connection> = {}): Connection {
    return {
        id: 'srt-input-a:mpegts-out-mpegts-muxer-b:audio-0',
        sourceModuleId: 'srt-input-a',
        sourcePortId: 'mpegts-out',
        sinkModuleId: 'mpegts-muxer-b',
        sinkPortId: 'audio-0',
        streamType: 'muxed/mpegts',
        ...over,
    };
}

describe('BusFanoutCoordinator', () => {
    let attach: ReturnType<typeof vi.fn>;
    let detach: ReturnType<typeof vi.fn>;
    /** The producer's bus-attach target — a gst child process for pipeline
     *  producers, or a non-gst producer's own fan-out controller. */
    let target: { sendBusAttach: typeof attach; sendBusDetach: typeof detach };

    const PORT = 40002;
    const make = (opts: { connections?: Connection[] } = {}) => {
        const producer = { getBusAttachTarget: () => target };
        return new BusFanoutCoordinator(
            (id) => (id === 'srt-input-a' ? (producer as never) : undefined),
            () => PORT,
            () => opts.connections ?? [],
        );
    };

    beforeEach(() => {
        attach = vi.fn();
        detach = vi.fn();
        target = { sendBusAttach: attach, sendBusDetach: detach };
    });

    it('attaches a per-edge branch addressed by tee name + edge socket', () => {
        const c = conn();
        make().attach(c);
        expect(attach).toHaveBeenCalledWith(busTeeName(PORT), busEdgeSocketPath(PORT, c.id));
    });

    it('detaches by the same edge socket', () => {
        const c = conn();
        make().detach(c);
        expect(detach).toHaveBeenCalledWith(busEdgeSocketPath(PORT, c.id));
    });

    it('re-attaches only the producer\'s own muxed/mpegts source edges', () => {
        const mine = conn();
        const other = conn({
            id: 'x:out-y:in',
            sourceModuleId: 'someone-else',
        });
        const wrongType = conn({ id: 'z:out-w:in', streamType: 'audio/pcm' });
        make({ connections: [mine, other, wrongType] }).reattachProducer('srt-input-a');
        expect(attach).toHaveBeenCalledTimes(1);
        expect(attach).toHaveBeenCalledWith(busTeeName(PORT), busEdgeSocketPath(PORT, mine.id));
    });

    it('no-ops when the producer has no allocated channel port yet', () => {
        const c = conn();
        new BusFanoutCoordinator(
            () => ({ getBusAttachTarget: () => target }) as never,
            () => undefined, // port not allocated
            () => [c],
        ).attach(c);
        expect(attach).not.toHaveBeenCalled();
    });

    it('no-ops when the producer attach target is down', () => {
        const c = conn();
        new BusFanoutCoordinator(
            () => ({ getBusAttachTarget: () => null }) as never,
            () => PORT,
            () => [c],
        ).attach(c);
        expect(attach).not.toHaveBeenCalled();
    });
});
