import { describe, it, expect, vi } from 'vitest';
import { ProbeReport, degradedText } from './probeReport.js';
import { FALLBACK_DECODER_WARNING } from './reprobeLoop.js';

const NAMES: Record<string, string> = { 'atx-1': 'FRA IN', 'split-1': 'VV', 'srt-2': 'SCC -> FRA' };
const SPLITTER = { sourceModuleId: 'split-1', port: 40013, socketPath: '/tmp/mr-bus-40013-x.sock' };
const SRT = { sourceModuleId: 'srt-2', port: 40002, socketPath: '/tmp/mr-bus-40002-y.sock' };
const IDLE = { codec: 'unknown', rawCaps: '' };
const AAC = {
    codec: 'aac',
    channels: 2,
    sampleRate: 48000,
    rawCaps: 'audio/mpeg, mpegversion=(int)4, rate=(int)48000, channels=(int)2',
};
const ODD = { codec: 'unknown', rawCaps: 'audio/x-odd, rate=(int)48000' };

function makeReport() {
    const seen: Array<[string, string]> = [];
    const log = {
        info: vi.fn((_obj: object, msg: string) => void seen.push(['info', msg])),
        warn: vi.fn((_obj: object, msg: string) => void seen.push(['warn', msg])),
    };
    const report = new ProbeReport({
        log: () => log,
        name: (id) => NAMES[id] ?? id,
        self: () => 'atx-1',
    });
    /** Every line so far, in order, as [level, msg]. */
    const lines = () => seen;
    return { report, log, lines };
}

describe('ProbeReport (B-201)', () => {
    it('an idle source probed many times is logged once, naming both modules', () => {
        const { report, log, lines } = makeReport();
        for (let i = 0; i < 60; i++) report.note(IDLE, SPLITTER);
        expect(lines()).toEqual([['info', 'FRA IN: no audio from VV yet — waiting for it']]);
        expect(log.info.mock.calls[0][0]).toEqual({
            source: 'split-1',
            port: 40013,
            socket: '/tmp/mr-bus-40013-x.sock',
        });
    });

    it('audio found is one line, its codec and channels, and stays quiet while it holds', () => {
        const { report, log, lines } = makeReport();
        report.note(IDLE, SPLITTER);
        for (let i = 0; i < 5; i++) report.note(AAC, SPLITTER);
        expect(lines()).toEqual([
            ['info', 'FRA IN: no audio from VV yet — waiting for it'],
            ['info', 'FRA IN: audio from VV is aac, 2 channels'],
        ]);
        expect(log.info.mock.calls[1][0]).toMatchObject({ codec: 'aac', rawCaps: AAC.rawCaps });
    });

    it('audio lost again from the same producer is a warning, once', () => {
        const { report, lines } = makeReport();
        report.note(AAC, SPLITTER);
        for (let i = 0; i < 5; i++) report.note(IDLE, SPLITTER);
        expect(lines()).toEqual([
            ['info', 'FRA IN: audio from VV is aac, 2 channels'],
            ['warn', 'FRA IN: no audio from VV any more — waiting for it'],
        ]);
    });

    it('another producer is a change: its wait is logged as a new one', () => {
        const { report, lines } = makeReport();
        report.note(IDLE, SPLITTER);
        report.note(IDLE, SRT);
        report.note(IDLE, SRT);
        report.note(AAC, SPLITTER);
        report.note(IDLE, SRT);
        expect(lines()).toEqual([
            ['info', 'FRA IN: no audio from VV yet — waiting for it'],
            ['info', 'FRA IN: no audio from SCC -> FRA yet — waiting for it'],
            ['info', 'FRA IN: audio from VV is aac, 2 channels'],
            ['info', 'FRA IN: no audio from SCC -> FRA yet — waiting for it'],
        ]);
    });

    it('a codec change is logged; audio the probe does not know is a warning with its caps', () => {
        const { report, log, lines } = makeReport();
        report.note(AAC, SPLITTER);
        report.note({ codec: 'opus', channels: 1, rawCaps: 'audio/x-opus' }, SPLITTER);
        report.note(ODD, SPLITTER);
        report.note(ODD, SPLITTER);
        expect(lines()).toEqual([
            ['info', 'FRA IN: audio from VV is aac, 2 channels'],
            ['info', 'FRA IN: audio from VV is opus, 1 channel'],
            [
                'warn',
                'FRA IN: audio from VV has a codec the probe does not know — using the generic decoder',
            ],
        ]);
        expect(log.warn.mock.calls[0][0]).toMatchObject({ rawCaps: ODD.rawCaps });
    });
});

describe('degradedText', () => {
    it('no audio caps reads as no source, its producer and the cadence named', () => {
        expect(degradedText(IDLE, 'VV')).toBe(
            'No source — waiting for audio from VV (checked every 10 s)',
        );
        expect(degradedText(null, 'VV')).toBe(
            'No source — waiting for audio from VV (checked every 10 s)',
        );
    });

    it('audio caps no classifier knows keep the generic-decoder text', () => {
        expect(degradedText(ODD, 'VV')).toBe(FALLBACK_DECODER_WARNING);
    });
});
