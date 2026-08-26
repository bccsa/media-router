import { describe, it, expect, vi, afterEach } from 'vitest';
import { hasPollableStages, readChainMeters, MeterPoll } from './statusPoll.js';
import type { ChainStages } from './lspProcessing.js';

const stages = (over: Partial<ChainStages> = {}): ChainStages => ({
    hpf: false,
    eqElement: null,
    dynElement: null,
    dynMode: 'none',
    keyedGate: false,
    limiterElement: null,
    duckerKey: false,
    ...over,
});

/** Property reader over a `${element}.${prop}` table; anything absent reads
 *  back undefined, exactly as an unknown LSP port would. */
const reader = (table: Record<string, unknown>) =>
    vi.fn(async (element: string, prop: string) => table[`${element}.${prop}`]);

const DB = (db: number) => 10 ** (db / 20); // LSP meters are linear gain factors

describe('hasPollableStages', () => {
    it('is false for a chain with no LADSPA element (ducker / bypass)', () => {
        expect(hasPollableStages(stages())).toBe(false);
        expect(hasPollableStages(stages({ dynMode: 'ducker', duckerKey: true }))).toBe(false);
        expect(hasPollableStages(stages({ hpf: true }))).toBe(false); // native element
        expect(hasPollableStages(stages({ eqElement: 'eq-el' }))).toBe(true);
        expect(hasPollableStages(stages({ limiterElement: 'lim-el' }))).toBe(true);
    });
});

describe('readChainMeters', () => {
    it('reads BOTH channels of input AND output — the EQ uses signal-meter ports', async () => {
        const read = reader({
            'eq.latency': 96,
            'eq.input-signal-meter-left': DB(-20),
            'eq.input-signal-meter-right': DB(-23),
            'eq.output-signal-meter-left': DB(-14),
            'eq.output-signal-meter-right': DB(-17),
        });
        const { status } = await readChainMeters(stages({ eqElement: 'eq-el' }), read);
        expect(status.inputLevel).toBe('-20.0 / -23.0 dB');
        expect(status.outputLevel).toBe('-14.0 / -17.0 dB');
        expect(status.latency).toBe('2.0 ms'); // 96 samples / 48 kHz
    });

    it('uses the level-meter port names on the dynamics elements', async () => {
        // Verified with gst-inspect on lsp-plugins-ladspa 1.2.5: the parametric
        // EQ names its globals `*-signal-meter-*`, every dynamics element
        // `*-level-meter-*`. Reading the wrong one silently shows '—'.
        const read = reader({
            'dyn.input-level-meter-left': DB(-6),
            'dyn.input-level-meter-right': DB(-6),
            'dyn.output-level-meter-left': DB(-9),
            'dyn.output-level-meter-right': DB(-9),
            'dyn.reduction-level-meter': DB(-3),
            'dyn.sidechain-level-meter': DB(-12),
        });
        const { status, grDb } = await readChainMeters(
            stages({ dynElement: 'comp-el', dynMode: 'compressor' }),
            read,
        );
        expect(status.inputLevel).toBe('-6.0 / -6.0 dB');
        expect(status.outputLevel).toBe('-9.0 / -9.0 dB');
        expect(status.keyLevel).toBe('-12.0 dB');
        expect(status.gainReduction).toBe('-3.0 dB');
        expect(grDb).toBeCloseTo(-3, 5);
        expect(read).not.toHaveBeenCalledWith('dyn', 'input-signal-meter-left');
    });

    it('brackets the whole chain: input off the FIRST stage, output off the LAST', async () => {
        const read = reader({
            'eq.input-signal-meter-left': DB(-20),
            'eq.input-signal-meter-right': DB(-20),
            'lim.output-level-meter-left': DB(-1),
            'lim.output-level-meter-right': DB(-1),
        });
        const { status } = await readChainMeters(
            stages({ eqElement: 'eq-el', dynElement: 'comp-el', limiterElement: 'lim-el' }),
            read,
        );
        expect(status.inputLevel).toBe('-20.0 / -20.0 dB');
        expect(status.outputLevel).toBe('-1.0 / -1.0 dB');
        // The middle stage is read for latency only, not for meters.
        expect(read).not.toHaveBeenCalledWith('dyn', 'input-level-meter-left');
        expect(read).not.toHaveBeenCalledWith('dyn', 'output-level-meter-left');
    });

    it('sums the reported latency of every present stage (samples → ms at 48 kHz)', async () => {
        const read = reader({ 'eq.latency': 240, 'dyn.latency': 48, 'lim.latency': 960 });
        const { status } = await readChainMeters(
            stages({ eqElement: 'eq-el', dynElement: 'dyn-el', limiterElement: 'lim-el' }),
            read,
        );
        expect(status.latency).toBe('26.0 ms'); // (240 + 48 + 960) / 48
    });

    it('shows a silent or unreadable meter as an em dash, per side', async () => {
        const read = reader({
            'eq.input-signal-meter-left': DB(-30),
            'eq.input-signal-meter-right': 0, // silent channel
        });
        const { status, grDb } = await readChainMeters(stages({ eqElement: 'eq-el' }), read);
        expect(status.inputLevel).toBe('-30.0 / — dB');
        expect(status.outputLevel).toBe('—'); // neither side readable
        expect(status.gainReduction).toBe('—');
        expect(status.keyLevel).toBeUndefined(); // no dynamics stage
        expect(grDb).toBeNull();
    });

    it('falls back to the limiter for gain reduction when there is no dynamics stage', async () => {
        const read = reader({ 'lim.gain-reduction-level-meter-left': DB(-2) });
        const { status, grDb } = await readChainMeters(stages({ limiterElement: 'lim-el' }), read);
        expect(status.gainReduction).toBe('-2.0 dB');
        expect(grDb).toBeCloseTo(-2, 5);
    });

    it('reports zero latency and no meters for a chain with no LADSPA element', async () => {
        const read = reader({});
        const { status } = await readChainMeters(stages({ dynMode: 'ducker' }), read);
        expect(status.latency).toBe('0.0 ms');
        expect(status.inputLevel).toBeUndefined();
        expect(read).not.toHaveBeenCalled();
    });
});

describe('MeterPoll', () => {
    afterEach(() => vi.useRealTimers());

    function mkPoll(table: Record<string, unknown>) {
        const publish = vi.fn();
        const badge = vi.fn();
        const poll = new MeterPoll({ read: reader(table), publish, badge });
        return { poll, publish, badge };
    }

    it('publishes on a 1 Hz tick and stops cleanly', async () => {
        vi.useFakeTimers();
        const { poll, publish } = mkPoll({ 'eq.latency': 48 });
        poll.start(stages({ eqElement: 'eq-el' }));
        expect(publish).not.toHaveBeenCalled(); // nothing before the first tick
        await vi.advanceTimersByTimeAsync(1000);
        expect(publish).toHaveBeenCalledWith(
            expect.objectContaining({ latency: '1.0 ms' }),
            expect.objectContaining({ grDb: null, inDb: null }),
        );

        poll.stop();
        publish.mockClear();
        await vi.advanceTimersByTimeAsync(3000);
        expect(publish).not.toHaveBeenCalled();
    });

    it('never starts a timer for a chain with nothing to read', async () => {
        vi.useFakeTimers();
        const { poll, publish } = mkPoll({});
        poll.start(stages({ dynMode: 'ducker', duckerKey: true }));
        await vi.advanceTimersByTimeAsync(3000);
        expect(publish).not.toHaveBeenCalled();
        poll.stop(); // a stop without a start is safe
    });

    it('restarting replaces the timer rather than stacking one', async () => {
        vi.useFakeTimers();
        const { poll, publish } = mkPoll({ 'eq.latency': 48 });
        poll.start(stages({ eqElement: 'eq-el' }));
        poll.start(stages({ eqElement: 'eq-el' }));
        await vi.advanceTimersByTimeAsync(1000);
        expect(publish).toHaveBeenCalledTimes(1);
        poll.stop();
    });

    it('badges gain reduction past 1 dB, and clears it otherwise', async () => {
        vi.useFakeTimers();
        const reducing = mkPoll({ 'dyn.reduction-level-meter': DB(-6) });
        reducing.poll.start(stages({ dynElement: 'dyn-el', dynMode: 'compressor' }));
        await vi.advanceTimersByTimeAsync(1000);
        expect(reducing.badge).toHaveBeenCalledWith({
            icon: 'activity',
            text: '-6 dB',
            color: '#f59e0b',
        });
        reducing.poll.stop();

        const open = mkPoll({ 'dyn.reduction-level-meter': DB(-0.2) });
        open.poll.start(stages({ dynElement: 'dyn-el', dynMode: 'compressor' }));
        await vi.advanceTimersByTimeAsync(1000);
        expect(open.badge).toHaveBeenCalledWith(null);
        open.poll.stop();
    });
});
