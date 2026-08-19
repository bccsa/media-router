import { describe, it, expect } from 'vitest';
import { isConnectionReject, connectionRejectMessage } from './connectionReject.js';

describe('isConnectionReject', () => {
    // Every string below is a real throw from MediaRouter.createConnection /
    // PortRegistry.validateCompatibility — kept verbatim so a reworded throw
    // fails here rather than silently stopping the warning in the field.
    it.each([
        'Incompatible ports: Port accepts only muxed/mpegts — got audio/302m',
        'Incompatible ports: Stream type mismatch: audio/pcm → video/raw',
        'Incompatible ports: Channel mismatch: 2 → 8',
        'Source port not found: mod-a:out',
        'Sink port not found: mod-b:in',
        'Source port out is not an output',
        'Sink port in is not an input',
        'Port in does not allow connections',
        'Port in already has 1/1 connections',
        'Port out already has 4/4 connections',
    ])('classifies a settled refusal: %s', (msg) => {
        expect(isConnectionReject(msg)).toBe(true);
    });

    it.each([
        'pw-link failed: node not found',
        'no assigned port yet',
        'Timed out waiting for PipeWire node',
        'ECONNREFUSED',
        'fail',
    ])('leaves a transient failure to the retries: %s', (msg) => {
        expect(isConnectionReject(msg)).toBe(false);
    });

    // The capacity marker is the word "connections", which on its own would
    // match ordinary chatter — it is matched on its full shape instead.
    it('does not match loose prose containing "connections"', () => {
        expect(isConnectionReject('retrying connections after restart')).toBe(false);
    });
});

describe('connectionRejectMessage', () => {
    it('drops the Incompatible ports prefix and names the source edge', () => {
        expect(
            connectionRejectMessage(
                'Incompatible ports: Port accepts only muxed/mpegts — got audio/302m',
                'ts-split-1',
                'out',
            ),
        ).toBe(
            'Not connected: Port accepts only muxed/mpegts — got audio/302m (from ts-split-1:out)',
        );
    });

    it('quotes a non-prefixed reason verbatim', () => {
        expect(connectionRejectMessage('Port in already has 1/1 connections', 'dec-1', 'pcm')).toBe(
            'Not connected: Port in already has 1/1 connections (from dec-1:pcm)',
        );
    });
});
