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

    it('re-attaches only the producer\'s own bus-carried source edges', () => {
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

    it('re-attaches audio/302m edges too — a restarted 302M producer (mixer) must not strand its consumers', () => {
        // Regression: reattachProducer filtered on streamType === 'muxed/mpegts'
        // only, so a restarted audio-mixer's output branch never re-attached and
        // downstream sat in "Waiting for producer bus socket(s)" forever.
        const c302m = conn({
            id: 'srt-input-a:mpegts-out-aout:audio-in',
            streamType: 'audio/302m',
        });
        make({ connections: [c302m] }).reattachProducer('srt-input-a');
        expect(attach).toHaveBeenCalledTimes(1);
        expect(attach).toHaveBeenCalledWith(busTeeName(PORT), busEdgeSocketPath(PORT, c302m.id));
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

describe('BusFanoutCoordinator — stale consumer relaunch on producer PLAYING', () => {
    const PORT = 40002;
    // ADR-0010 rule 4: a consumer launched at/before the producer's current launch holds a dead edge.
    function rig(opts: { producerLaunch?: number; consumerLaunch?: number; conns?: Connection[] }) {
        const attach = vi.fn();
        const restart = vi.fn(async () => {});
        const producer = {
            getBusAttachTarget: () => ({ sendBusAttach: attach, sendBusDetach: vi.fn() }),
            getChildProcess: () => ({ pipelineLaunchedAt: opts.producerLaunch }),
        };
        const consumer = {
            getChildProcess: () => ({ pipelineLaunchedAt: opts.consumerLaunch, restartPipeline: restart }),
        };
        const conns = opts.conns ?? [conn()];
        const coord = new BusFanoutCoordinator(
            (id) =>
                id === 'srt-input-a'
                    ? (producer as never)
                    : id === 'mpegts-muxer-b'
                      ? (consumer as never)
                      : undefined,
            () => PORT,
            () => conns,
        );
        return { coord, attach, restart };
    }

    it('relaunches a consumer that launched before the producer, after re-attaching its edge', () => {
        const { coord, attach, restart } = rig({ producerLaunch: 2000, consumerLaunch: 1000 });
        coord.reattachProducer('srt-input-a');
        expect(attach).toHaveBeenCalledTimes(1);
        expect(restart).toHaveBeenCalledTimes(1);
        expect(restart.mock.calls[0][0]).toContain('srt-input-a');
        expect(attach.mock.invocationCallOrder[0]).toBeLessThan(restart.mock.invocationCallOrder[0]);
    });

    it('treats a same-millisecond launch as stale — a live attachment can only postdate the producer', () => {
        const { coord, restart } = rig({ producerLaunch: 2000, consumerLaunch: 2000 });
        coord.reattachProducer('srt-input-a');
        expect(restart).toHaveBeenCalledTimes(1);
    });

    it('leaves a consumer that launched after the producer alone (it holds the live edge)', () => {
        const { coord, restart } = rig({ producerLaunch: 1000, consumerLaunch: 2000 });
        coord.reattachProducer('srt-input-a');
        expect(restart).not.toHaveBeenCalled();
    });

    it('leaves a consumer with no launch time alone — it is down or already restarting', () => {
        const { coord, restart } = rig({ producerLaunch: 2000, consumerLaunch: undefined });
        coord.reattachProducer('srt-input-a');
        expect(restart).not.toHaveBeenCalled();
    });

    it('does nothing when the producer launch time is unknown (non-gst producer)', () => {
        const { coord, restart } = rig({ producerLaunch: undefined, consumerLaunch: 1000 });
        coord.reattachProducer('srt-input-a');
        expect(restart).not.toHaveBeenCalled();
    });

    it('relaunches a consumer once even with several edges from the same producer', () => {
        const a = conn();
        const b = conn({ id: 'srt-input-a:mpegts-out-mpegts-muxer-b:audio-1', sinkPortId: 'audio-1' });
        const { coord, attach, restart } = rig({ producerLaunch: 2000, consumerLaunch: 1000, conns: [a, b] });
        coord.reattachProducer('srt-input-a');
        expect(attach).toHaveBeenCalledTimes(2);
        expect(restart).toHaveBeenCalledTimes(1);
    });
});
