/**
 * Width of the 302M stream a producer configured for `channels` actually puts
 * on the bus: 302M carries only 2/4/6/8, so odd counts round up and mono goes
 * out as dual-mono stereo (mirrors `normalize302mChannels` in audio-302m-core,
 * ADR-0014). The channel-map editor sizes a 302M source grid from this, not
 * from the raw setting, so a Mono N-1 output shows the two wire channels the
 * consumer's matrix is built against.
 */
export function wire302mChannels(channels: unknown): number {
    const v = Number(channels);
    if (!Number.isFinite(v) || v <= 2) return 2;
    if (v >= 8) return 8;
    return v % 2 === 0 ? v : v + 1;
}
