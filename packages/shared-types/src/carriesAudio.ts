/**
 * A module carries audio, so it has levels: any `audio/*` port (pcm, 302m
 * PCM-in-TS, opus, aac), or an input that `acceptsAnyTs` — the audio-transcoder
 * decoding a muxed TS / 302M stream, whose outputs are typed `muxed/mpegts`.
 */
export function carriesAudio(ports: ReadonlyArray<{ streamType?: string; acceptsAnyTs?: boolean }> | undefined): boolean {
    return ports?.some((p) => !!p.streamType?.startsWith('audio/') || p.acceptsAnyTs === true) ?? false;
}
