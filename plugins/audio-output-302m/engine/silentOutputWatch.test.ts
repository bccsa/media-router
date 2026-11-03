import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    LATE_SLACK_MS,
    NO_READING_MS,
    SILENT_OUTPUT_MS,
    SILENT_RELAUNCH_GAP_MS,
    SilentOutputWatch,
} from './silentOutputWatch.js';

/** B-197: .108's output showed ok while it played nothing. A fake host: a pipeline that may
 *  play, mix and deliver meter readings; the sink's lateness window; the warning it shows. */
function rig(opts: { mixes?: boolean } = {}) {
    const state = {
        playing: true,
        mixes: opts.mixes ?? true,
        lateness: undefined as { minMs: number } | undefined,
        warning: null as string | null,
    };
    const restartPipeline = vi.fn(async () => {});
    const log = { info: vi.fn(), warn: vi.fn() };
    const watch = new SilentOutputWatch({
        pipeline: () => ({ restartPipeline }),
        playing: () => state.playing,
        mixes: () => state.mixes,
        sinkLateness: () => state.lateness,
        playoutBudgetMs: () => 100,
        warn: (text) => {
            state.warning = text;
        },
        log: () => log,
    });
    /** `ms` of meter readings, one every 100 ms (the mix delivers). */
    const deliver = (ms: number) => {
        for (let t = 0; t < ms; t += 100) {
            watch.onVu();
            vi.advanceTimersByTime(100);
        }
    };
    return { state, watch, restartPipeline, log, deliver };
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
});
afterEach(() => vi.useRealTimers());

describe('SilentOutputWatch (B-197)', () => {
    it('a mixer that delivers nothing: a warning, not ok, and one relaunch; it stays until audio comes', () => {
        const r = rig();
        r.watch.onPlaying();
        r.deliver(2000);
        vi.advanceTimersByTime(NO_READING_MS + SILENT_OUTPUT_MS - 1000);
        expect(r.state.warning).toBeNull();
        vi.advanceTimersByTime(2000);
        expect(r.state.warning).toBe('Plays nothing: its mixer delivers no audio — relaunched');
        expect(r.restartPipeline).toHaveBeenCalledTimes(1);
        expect(r.log.warn).toHaveBeenCalledTimes(1);
        // The relaunch plays and is just as silent: the warning stays, no second relaunch.
        r.watch.onPlaying();
        expect(r.state.warning).toBe('Plays nothing: its mixer delivers no audio — relaunched');
        vi.advanceTimersByTime(3 * SILENT_OUTPUT_MS);
        expect(r.restartPipeline).toHaveBeenCalledTimes(1);
        expect(r.log.warn).toHaveBeenCalledTimes(1);
        r.deliver(1500);
        expect(r.state.warning).toBeNull();
        expect(r.log.info).toHaveBeenCalledWith({}, 'Plays again');
    });

    it('one source played direct: no audio is that source going quiet, not the output (FF9 has it)', () => {
        const r = rig({ mixes: false });
        r.watch.onPlaying();
        vi.advanceTimersByTime(4 * SILENT_OUTPUT_MS);
        expect(r.state.warning).toBeNull();
        expect(r.restartPipeline).not.toHaveBeenCalled();
    });

    it('every buffer past its playout time: said, not relaunched (the re-anchor raises the route)', () => {
        const r = rig();
        r.watch.onPlaying();
        r.state.lateness = { minMs: 100 + 300 };
        r.deliver(SILENT_OUTPUT_MS - 1000);
        expect(r.state.warning).toBeNull();
        r.deliver(2000);
        expect(r.state.warning).toBe(
            'Plays nothing: every buffer reaches the sink 300 ms past its playout time',
        );
        r.deliver(10_000);
        expect(r.restartPipeline).not.toHaveBeenCalled();
        // The route was raised: buffers reach the sink in time again.
        r.state.lateness = { minMs: 60 };
        r.deliver(1500);
        expect(r.state.warning).toBeNull();
    });

    it('late by no more than the slack is not nothing: the ring plays most of it', () => {
        const r = rig({ mixes: false });
        r.watch.onPlaying();
        r.state.lateness = { minMs: 100 + LATE_SLACK_MS };
        r.deliver(4 * SILENT_OUTPUT_MS);
        expect(r.state.warning).toBeNull();
    });

    it('not playing (a gate, a PipeWire loss): no judgement, and an open warning stays', () => {
        const r = rig();
        r.watch.onPlaying();
        vi.advanceTimersByTime(2 * SILENT_OUTPUT_MS);
        expect(r.state.warning).toMatch(/^Plays nothing/);
        r.state.playing = false;
        vi.advanceTimersByTime(4 * SILENT_OUTPUT_MS);
        expect(r.state.warning).toMatch(/^Plays nothing/);
        expect(r.restartPipeline).toHaveBeenCalledTimes(1);
    });

    it('at most one relaunch a minute: a new episode soon after says so without one', () => {
        const r = rig();
        r.watch.onPlaying();
        vi.advanceTimersByTime(2 * SILENT_OUTPUT_MS);
        expect(r.restartPipeline).toHaveBeenCalledTimes(1);
        r.watch.onPlaying();
        r.deliver(2000);
        expect(r.state.warning).toBeNull();
        vi.advanceTimersByTime(2 * SILENT_OUTPUT_MS);
        expect(r.state.warning).toBe('Plays nothing: its mixer delivers no audio');
        expect(r.restartPipeline).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(SILENT_RELAUNCH_GAP_MS);
        expect(r.restartPipeline).toHaveBeenCalledTimes(2);
        expect(r.state.warning).toBe('Plays nothing: its mixer delivers no audio — relaunched');
    });

    it('stop withdraws the warning and judges nothing more', () => {
        const r = rig();
        r.watch.onPlaying();
        vi.advanceTimersByTime(2 * SILENT_OUTPUT_MS);
        expect(r.state.warning).not.toBeNull();
        r.watch.stop();
        expect(r.state.warning).toBeNull();
        vi.advanceTimersByTime(4 * SILENT_OUTPUT_MS);
        expect(r.state.warning).toBeNull();
        expect(r.restartPipeline).toHaveBeenCalledTimes(1);
    });
});
