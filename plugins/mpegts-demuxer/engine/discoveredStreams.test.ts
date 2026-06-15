import { describe, it, expect } from 'vitest';
import { diffDiscoveredStreams, streamsToConfig } from './discoveredStreams.js';
import type { DiscoveredStream } from './streamInspector.js';
import type { DiscoveredStreamConfig } from './mpegtsDemuxerPipeline.js';

const stream = (over: Partial<DiscoveredStream>): DiscoveredStream => ({
    pid: 0x100,
    media: 'video',
    caps: '',
    codec: 'h264',
    language: null,
    ...over,
});

describe('streamsToConfig', () => {
    it('projects live streams onto config, sorted video-then-audio by PID, with KLV name', () => {
        const out = streamsToConfig(
            [
                stream({ pid: 0x141, media: 'audio', codec: 'aac' }),
                stream({ pid: 0x100, media: 'video', codec: 'h264' }),
            ],
            new Map([[0x100, 'Cam 1']]),
        );
        expect(out.map((s) => s.pid)).toEqual([0x100, 0x141]);
        expect(out[0]).toEqual({ pid: 0x100, media: 'video', codec: 'h264', name: 'Cam 1' });
        expect(out[1]).toEqual({ pid: 0x141, media: 'audio', codec: 'aac' });
    });

    it('drops metadata, data, and null-PID streams (only routable video/audio become ports)', () => {
        const out = streamsToConfig(
            [
                stream({ pid: 0x1f0, media: 'metadata', codec: 'klv' }),
                stream({ pid: null, media: 'data', codec: 'x' }),
                stream({ pid: 0x100, media: 'video' }),
            ],
            new Map(),
        );
        expect(out.map((s) => s.pid)).toEqual([0x100]);
    });
});

describe('diffDiscoveredStreams', () => {
    const v = (pid: number, over: Partial<DiscoveredStreamConfig> = {}): DiscoveredStreamConfig => ({
        pid,
        media: 'video',
        ...over,
    });

    it('returns the merged set when a new PID appears', () => {
        const next = diffDiscoveredStreams([v(0x100)], [v(0x100), v(0x101)]);
        expect(next).not.toBeNull();
        expect(next!.map((s) => s.pid)).toEqual([0x100, 0x101]);
    });

    it('returns null when nothing changed (the debounce that avoids SQLite spam)', () => {
        expect(diffDiscoveredStreams([v(0x100)], [v(0x100)])).toBeNull();
    });

    it('returns the merged set when an existing PID gets a new name/codec', () => {
        const next = diffDiscoveredStreams(
            [v(0x100, { codec: 'h264' })],
            [v(0x100, { codec: 'h264', name: 'Cam 1' })],
        );
        expect(next).not.toBeNull();
        expect(next![0].name).toBe('Cam 1');
    });

    it('never removes a PID that is no longer present (D5 — kept, marked stale by the module)', () => {
        const next = diffDiscoveredStreams([v(0x100), v(0x101)], [v(0x100)]);
        // 0x101 absent from fresh but retained → set is identical → null (no write).
        expect(next).toBeNull();
    });

    it('keeps a retained PID when a different PID also changes', () => {
        const next = diffDiscoveredStreams([v(0x100), v(0x101)], [v(0x100, { name: 'X' })]);
        expect(next).not.toBeNull();
        expect(next!.map((s) => s.pid)).toEqual([0x100, 0x101]);
        expect(next!.find((s) => s.pid === 0x100)!.name).toBe('X');
    });
});
