import { rtpTimestampOffset, type HouseClock, type HouseEpoch } from '@media-router/engine';

/** The epoch this sender claims: the engine's E as an RTP `timestamp-offset`. */
export interface Aes67Epoch {
    eNs: bigint;
    rtpTimestampOffset: number;
    seq: number;
    source: HouseEpoch['source'];
    taiOffsetS: number;
}

type ClockView = Pick<HouseClock, 'epoch' | 'state'>;

/** Why this box may not claim the PTP epoch, or '' when it may. A free-running sender is
 *  honest; one announcing a media clock it does not have is undetectable at the receiver. */
export function epochRefusal(clock: ClockView | undefined): string {
    const tail = ' — RTP timestamps free-run';
    if (!clock) return `no engine house clock${tail}`;
    const st = clock.state();
    const ep = clock.epoch();
    if (!st.sidecar) return `mr-clockstate missing, no house epoch${tail}`;
    if (!ep) return `no house epoch yet${tail}`;
    if (ep.traceable) return '';
    if (st.source === 'none') return `no time daemon (source none), epoch untraceable${tail}`;
    if (st.taiOffsetS < 10) return `kernel TAI offset unset, epoch untraceable${tail}`;
    return `clock not synchronised, epoch untraceable${tail}`;
}

export function claimEpoch(ep: HouseEpoch): Aes67Epoch {
    return {
        eNs: ep.eNs,
        rtpTimestampOffset: rtpTimestampOffset(ep.eNs),
        seq: ep.seq,
        source: ep.source,
        taiOffsetS: ep.taiOffsetS,
    };
}

/** Does a house-clock change move what this sender should stamp? A re-latch moves E; gaining
 *  traceability makes a claim possible. Losing it does not: E is still right (no step), so
 *  the claim stays and the face warns. */
export function epochChangeNeedsRestart(
    claimed: Aes67Epoch | null,
    ep: HouseEpoch | null,
): boolean {
    if (!ep) return false;
    if (claimed) return ep.eNs !== claimed.eNs;
    return ep.traceable;
}
