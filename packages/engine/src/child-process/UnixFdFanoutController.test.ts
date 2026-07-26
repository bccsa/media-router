import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NativeSinkController, UnixFdFanoutController } from './UnixFdFanoutController.js';
import type { ManagedProcess } from './ManagedProcess.js';

describe('UnixFdFanoutController', () => {
    let written: string[];
    let procUp: boolean;
    let onReady: ReturnType<typeof vi.fn>;
    let ctrl: UnixFdFanoutController;

    const fakeProc = {
        writeLine: (line: string) => {
            if (!procUp) return false;
            written.push(line);
            return true;
        },
    } as unknown as ManagedProcess;

    beforeEach(() => {
        written = [];
        procUp = true;
        onReady = vi.fn();
        ctrl = new UnixFdFanoutController(() => (procUp ? fakeProc : null), onReady);
    });

    const parse = (lines: string[]) => lines.map((l) => JSON.parse(l));

    it('forwards attach/detach as sidecar control lines', () => {
        ctrl.sendBusAttach('busout_41000', '/tmp/mr-bus-41000-abc.sock');
        ctrl.sendBusDetach('/tmp/mr-bus-41000-abc.sock');
        expect(parse(written)).toEqual([
            { cmd: 'bus_attach', tee: 'busout_41000', socket: '/tmp/mr-bus-41000-abc.sock' },
            { cmd: 'bus_detach', socket: '/tmp/mr-bus-41000-abc.sock' },
        ]);
    });

    it('replays the desired edge set on every sidecar ready (respawn recovery)', () => {
        ctrl.sendBusAttach('busout_41000', '/tmp/a.sock');
        ctrl.sendBusAttach('busout_41000', '/tmp/b.sock');
        written = [];

        // Sidecar restarted — a fresh process has no listeners.
        expect(ctrl.handleLine('{"event":"ready"}')).toEqual({ event: 'ready' });
        expect(parse(written)).toEqual([
            { cmd: 'bus_attach', tee: 'busout_41000', socket: '/tmp/a.sock' },
            { cmd: 'bus_attach', tee: 'busout_41000', socket: '/tmp/b.sock' },
        ]);
        expect(onReady).toHaveBeenCalledTimes(1);
    });

    it('detached edges are dropped from the replay set', () => {
        ctrl.sendBusAttach('busout_41000', '/tmp/a.sock');
        ctrl.sendBusAttach('busout_41000', '/tmp/b.sock');
        ctrl.sendBusDetach('/tmp/a.sock');
        written = [];
        ctrl.handleLine('{"event":"ready"}');
        expect(parse(written)).toEqual([
            { cmd: 'bus_attach', tee: 'busout_41000', socket: '/tmp/b.sock' },
        ]);
    });

    it('records desired edges while the sidecar is down, replays once up', () => {
        procUp = false;
        ctrl.sendBusAttach('busout_41000', '/tmp/a.sock'); // writeLine no-ops
        expect(written).toEqual([]);

        procUp = true;
        ctrl.handleLine('{"event":"ready"}');
        expect(parse(written)).toEqual([
            { cmd: 'bus_attach', tee: 'busout_41000', socket: '/tmp/a.sock' },
        ]);
    });

    it('passes parsed non-ready lines through and ignores noise', () => {
        expect(ctrl.handleLine('{"stats":{"clients":2}}')).toEqual({ stats: { clients: 2 } });
        expect(ctrl.handleLine('not json')).toBeNull();
        expect(ctrl.handleLine('{broken')).toBeNull();
        expect(onReady).not.toHaveBeenCalled();
    });
});

describe('NativeSinkController reinput RPC', () => {
    let written: string[];
    let ctrl: NativeSinkController;

    const fakeProc = {
        writeLine: (line: string) => {
            written.push(line);
            return true;
        },
    } as unknown as ManagedProcess;

    beforeEach(() => {
        written = [];
        ctrl = new NativeSinkController(() => fakeProc);
    });
    afterEach(() => vi.useRealTimers());

    it('writes the reinput verb and resolves on reinput_done', async () => {
        const p = ctrl.busReinput('netin', '/tmp/new-edge.sock');
        expect(JSON.parse(written[0])).toEqual({ cmd: 'reinput', socket: '/tmp/new-edge.sock' });
        ctrl.handleLine('{"event":"reinput_done","socket":"/tmp/new-edge.sock"}');
        await expect(p).resolves.toBeUndefined();
    });

    it('rejects on reinput_failed with the child message', async () => {
        const p = ctrl.busReinput('netin', '/tmp/new-edge.sock');
        ctrl.handleLine('{"event":"reinput_failed","message":"no listener"}');
        await expect(p).rejects.toThrow('no listener');
    });

    it('times out when the child never answers', async () => {
        vi.useFakeTimers();
        const p = ctrl.busReinput('netin', '/tmp/new-edge.sock');
        const outcome = expect(p).rejects.toThrow('timed out');
        await vi.advanceTimersByTimeAsync(7000);
        await outcome;
    });

    it('a newer reinput supersedes (rejects) an in-flight one', async () => {
        const first = ctrl.busReinput('netin', '/tmp/a.sock');
        const firstOutcome = expect(first).rejects.toThrow('superseded');
        const second = ctrl.busReinput('netin', '/tmp/b.sock');
        ctrl.handleLine('{"event":"reinput_done","socket":"/tmp/b.sock"}');
        await firstOutcome;
        await expect(second).resolves.toBeUndefined();
    });

    it('inherits attach replay-on-ready from the fan-out controller', () => {
        ctrl.sendBusAttach('busout_41000', '/tmp/a.sock');
        written = [];
        ctrl.handleLine('{"event":"ready"}');
        expect(JSON.parse(written[0])).toEqual({
            cmd: 'bus_attach',
            tee: 'busout_41000',
            socket: '/tmp/a.sock',
        });
    });
});
