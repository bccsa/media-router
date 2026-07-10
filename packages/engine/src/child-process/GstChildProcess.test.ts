import { describe, it, expect, vi } from 'vitest';
import { GstChildProcess, throwIfRpcError } from './GstChildProcess.js';

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

describe('sticky property replay', () => {
    // Drives the record/replay contract without forking a child: inject a
    // fake ControlIpc and flip `running` the way the stateChange handler does.
    function harness() {
        const child = new GstChildProcess('/nonexistent/gst-runner.js') as any;
        const sendRequest = vi.fn(async () => ({}));
        child.ipc = { sendRequest, destroy: vi.fn() };
        child.running = true;
        return { child, sendRequest };
    }

    it('records the last value per element property and replays all of them', async () => {
        const { child, sendRequest } = harness();
        await child.setProperty('vol', 'volume', 0.5);
        await child.setProperty('vol', 'volume', 0.25); // supersedes 0.5
        await child.setProperty('nov', 'text', 'Cam 1');
        sendRequest.mockClear();

        await child.replayStickyProps();
        expect(sendRequest).toHaveBeenCalledTimes(2); // one per property, latest value
        expect(sendRequest).toHaveBeenCalledWith(
            'setProperty',
            { element: 'vol', property: 'volume', value: 0.25 },
            2000,
        );
        expect(sendRequest).toHaveBeenCalledWith(
            'setProperty',
            { element: 'nov', property: 'text', value: 'Cam 1' },
            2000,
        );
    });

    it('records intent while the pipeline is down and applies it on replay', async () => {
        const child = new GstChildProcess('/nonexistent/gst-runner.js') as any;
        // No ipc, not running — the set can't be delivered, but must be kept.
        await child.setProperty('vol', 'volume', 0.7);

        const sendRequest = vi.fn(async () => ({}));
        child.ipc = { sendRequest };
        child.running = true;
        await child.replayStickyProps();
        expect(sendRequest).toHaveBeenCalledWith(
            'setProperty',
            { element: 'vol', property: 'volume', value: 0.7 },
            2000,
        );
    });

    it('a failed replay of one property does not block the others', async () => {
        const { child, sendRequest } = harness();
        await child.setProperty('gone', 'volume', 0.5);
        await child.setProperty('vol', 'volume', 0.25);
        sendRequest.mockImplementation(async (_a: string, d: { element: string }) =>
            d.element === 'gone' ? { error: 'Element not found: gone' } : {},
        );
        await child.replayStickyProps(); // must not throw
        expect(sendRequest).toHaveBeenCalledWith(
            'setProperty',
            expect.objectContaining({ element: 'vol' }),
            2000,
        );
    });

    it('stop() clears the recorded properties', async () => {
        const { child, sendRequest } = harness();
        await child.setProperty('vol', 'volume', 0.5);
        await child.stop();
        child.ipc = { sendRequest, destroy: vi.fn() };
        child.running = true;
        sendRequest.mockClear();
        await child.replayStickyProps();
        expect(sendRequest).not.toHaveBeenCalled();
    });
});
