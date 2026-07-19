import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UnixFdFanoutController } from './UnixFdFanoutController.js';
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
