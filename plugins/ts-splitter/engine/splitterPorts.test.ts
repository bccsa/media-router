import { describe, it, expect } from 'vitest';
import {
    INPUT_PORT_ID,
    buildDynamicPorts,
    discoveredStreams,
    mergeDiscovered,
    pidFromPortId,
    pidPortId,
    type DiscoveredStreamConfig,
} from './splitterPorts.js';

const video = (pid: number): DiscoveredStreamConfig => ({ pid, streamType: 0x1b, media: 'video', codec: 'h264' });
const audio = (pid: number): DiscoveredStreamConfig => ({ pid, streamType: 0x0f, media: 'audio', codec: 'aac' });
const opus = (pid: number): DiscoveredStreamConfig => ({
    pid,
    streamType: 0x06,
    media: 'audio',
    codec: 'opus',
    language: 'nor',
});

describe('pid port ids', () => {
    it('round-trips pid <-> portId and rejects non-pid ports', () => {
        expect(pidPortId(0x65)).toBe('pid-0x65');
        expect(pidFromPortId('pid-0x65')).toBe(0x65);
        expect(pidFromPortId('mpegts-in')).toBeNull();
        expect(pidFromPortId('pid-nope')).toBeNull();
    });
});

describe('buildDynamicPorts', () => {
    it('is input-only when nothing is discovered', () => {
        const ports = buildDynamicPorts([]);
        expect(ports.map((p) => p.id)).toEqual([INPUT_PORT_ID]);
        expect(ports[0]).toMatchObject({ direction: 'input', maxConnections: 1 });
        // Strict accept list: a 302M stream is valid TS but has nothing to
        // split — opt out of TS-family leniency.
        expect(ports[0].acceptsStreamTypes).toEqual(['muxed/mpegts']);
    });

    it('adds one output per discovered stream, sorted by PID', () => {
        const ports = buildDynamicPorts([audio(0xcc), video(0x65)]);
        expect(ports.map((p) => p.id)).toEqual([INPUT_PORT_ID, 'pid-0x65', 'pid-0xcc']);
        expect(ports[1]).toMatchObject({
            direction: 'output',
            maxConnections: -1,
            requiresOrderedApply: true,
            label: 'Video (h264, PID 0x65)',
        });
    });

    it('carries structured streamInfo for compact pin display (decimal pid, codec, language)', () => {
        const ports = buildDynamicPorts([{ ...audio(0xc9), language: 'nor' }, video(0x65)]);
        expect(ports.find((p) => p.id === 'pid-0xc9')!.streamInfo).toEqual({
            pid: 0xc9,
            media: 'audio',
            codec: 'aac',
            language: 'nor',
        });
        // No language descriptor → no language key (pin falls back to PID).
        expect(ports.find((p) => p.id === 'pid-0x65')!.streamInfo).toEqual({
            pid: 0x65,
            media: 'video',
            codec: 'h264',
        });
    });

    it('uses the persisted media/codec, so a descriptor-derived Opus stays opus', () => {
        // Opus rides stream_type 0x06: re-deriving from streamType here would
        // report it as private data (issue #698).
        const ports = buildDynamicPorts([opus(0x20)]);
        const port = ports.find((p) => p.id === 'pid-0x20')!;
        expect(port.streamInfo).toEqual({
            pid: 0x20,
            media: 'audio',
            codec: 'opus',
            language: 'nor',
        });
        expect(port.label).toBe('Audio nor (opus, PID 0x20)');
    });
});

describe('mergeDiscovered', () => {
    it('adds new PIDs, keeps absent ones, and returns null when unchanged', () => {
        const a = [video(0x65)];
        const merged = mergeDiscovered(a, [audio(0xcc)]);
        expect(merged?.map((s) => s.pid)).toEqual([0x65, 0xcc]); // new added, old kept
        expect(mergeDiscovered(merged!, [])).toBeNull(); // absent kept => no change
        expect(mergeDiscovered(a, a)).toBeNull(); // identical
    });

    it('updates in place when a PID changes stream_type', () => {
        const merged = mergeDiscovered([{ ...video(0x65), streamType: 0x02 }], [video(0x65)]);
        expect(merged).not.toBeNull();
        expect(merged![0].streamType).toBe(0x1b);
    });

    it('re-persists when only the codec changes (Opus 0x06 persisted as private)', () => {
        const stale = [{ ...opus(0x20), media: 'data' as const, codec: 'private' }];
        const merged = mergeDiscovered(stale, [opus(0x20)]);
        expect(merged).not.toBeNull();
        expect(merged![0]).toMatchObject({ media: 'audio', codec: 'opus' });
    });
});

describe('discoveredStreams', () => {
    it('reads the persisted array, defaulting to empty', () => {
        expect(discoveredStreams({})).toEqual([]);
        const s = [video(1)];
        expect(discoveredStreams({ discoveredStreams: s })).toBe(s);
    });
});
