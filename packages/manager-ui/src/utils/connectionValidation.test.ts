import { describe, it, expect } from 'vitest';
import { validateCandidateConnection } from './connectionValidation';
import type { PortInfo, ConnectionState } from '@/stores/engines';

function port(over: Partial<PortInfo> = {}): PortInfo {
    return {
        id: 'p',
        direction: 'output',
        streamType: 'muxed/mpegts',
        label: 'Port',
        maxConnections: -1,
        ...over,
    };
}

function edge(over: Partial<ConnectionState> = {}): ConnectionState {
    return {
        id: 'c',
        sourceModuleId: 'src',
        sourcePortId: 'out',
        sinkModuleId: 'snk',
        sinkPortId: 'in',
        ...over,
    };
}

describe('validateCandidateConnection', () => {
    it('accepts a plain output → input of the same type', () => {
        const r = validateCandidateConnection(
            { moduleId: 'a', port: port({ id: 'out' }) },
            { moduleId: 'b', port: port({ id: 'in', direction: 'input' }) },
            [],
        );
        expect(r.ok).toBe(true);
    });

    it('rejects input → input and output → output with a reason', () => {
        const r = validateCandidateConnection(
            { moduleId: 'a', port: port({ direction: 'input' }) },
            { moduleId: 'b', port: port({ direction: 'input' }) },
            [],
        );
        expect(r).toEqual({ ok: false, reason: 'Connect an output to an input' });
    });

    it('rejects incompatible stream types with both types in the reason', () => {
        const r = validateCandidateConnection(
            { moduleId: 'a', port: port({ streamType: 'audio/pcm' }) },
            { moduleId: 'b', port: port({ direction: 'input', streamType: 'video/raw' }) },
            [],
        );
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toContain('audio/pcm → video/raw');
    });

    it('allows the TS family both ways (302M ↔ muxed)', () => {
        expect(
            validateCandidateConnection(
                { moduleId: 'a', port: port({ streamType: 'audio/302m' }) },
                { moduleId: 'b', port: port({ direction: 'input', streamType: 'muxed/mpegts' }) },
                [],
            ).ok,
        ).toBe(true);
    });

    it('acceptsStreamTypes opts the input out of TS-family leniency', () => {
        const splitterIn = port({
            id: 'mpegts-in',
            direction: 'input',
            label: 'MPEG-TS In',
            acceptsStreamTypes: ['muxed/mpegts'],
        });
        const r = validateCandidateConnection(
            { moduleId: 'mix', port: port({ streamType: 'audio/302m' }) },
            { moduleId: 'split', port: splitterIn },
            [],
        );
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toContain('accepts only muxed/mpegts');
    });

    it('resolves accept-list orientation when the user drags FROM the input side', () => {
        // Vue Flow allows dragging from either end: src = the INPUT port here.
        const splitterIn = port({
            id: 'mpegts-in',
            direction: 'input',
            label: 'MPEG-TS In',
            acceptsStreamTypes: ['muxed/mpegts'],
        });
        const r = validateCandidateConnection(
            { moduleId: 'split', port: splitterIn },
            { moduleId: 'mix', port: port({ streamType: 'audio/302m' }) },
            [],
        );
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toContain('accepts only muxed/mpegts');
    });

    it('enforces maxConnections with existing-edge counting on the right module+port', () => {
        const capIn = port({ id: 'in', direction: 'input', maxConnections: 1 });
        const existing = [edge({ sinkModuleId: 'b', sinkPortId: 'in' })];
        const r = validateCandidateConnection(
            { moduleId: 'a', port: port({ id: 'out' }) },
            { moduleId: 'b', port: capIn },
            existing,
        );
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toContain('1-connection limit');
        // Same edge count on a DIFFERENT module must not trip the cap.
        const r2 = validateCandidateConnection(
            { moduleId: 'a', port: port({ id: 'out' }) },
            { moduleId: 'other', port: capIn },
            existing,
        );
        expect(r2.ok).toBe(true);
    });

    it('maxConnections 0 rejects outright', () => {
        const r = validateCandidateConnection(
            { moduleId: 'a', port: port() },
            { moduleId: 'b', port: port({ direction: 'input', maxConnections: 0 }) },
            [],
        );
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toContain('does not allow connections');
    });
});
