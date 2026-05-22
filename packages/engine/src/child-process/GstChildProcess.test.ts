import { describe, it, expect } from 'vitest';
import { throwIfRpcError } from './GstChildProcess.js';

describe('throwIfRpcError', () => {
    it('throws an Error with the Python message when the result carries an error', () => {
        expect(() =>
            throwIfRpcError({ error: 'Element not found: nov' }, 'setProperty(nov.text)'),
        ).toThrowError('setProperty(nov.text): Element not found: nov');
    });

    it('does not throw for a successful response payload', () => {
        expect(() =>
            throwIfRpcError(
                { event: 'property_set', element: 'vol', property: 'volume', value: 0.5 },
                'setProperty(vol.volume)',
            ),
        ).not.toThrow();
    });

    it('does not throw for null or undefined results', () => {
        expect(() => throwIfRpcError(null, 'op')).not.toThrow();
        expect(() => throwIfRpcError(undefined, 'op')).not.toThrow();
    });

    it('ignores a non-string error field', () => {
        // Defensive: a stray `error: true` from a non-command_error payload
        // shouldn't be treated as an RPC failure.
        expect(() => throwIfRpcError({ error: true }, 'op')).not.toThrow();
    });
});
