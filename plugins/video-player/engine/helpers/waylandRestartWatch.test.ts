import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// `fs.watch` is wrapped (real by default) so the watcher-error path — which a
// real inotify watch will not produce on demand — can be driven directly.
vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    return { ...actual, watch: vi.fn(actual.watch) };
});

import {
    isWaylandSocketEvent,
    planWatcherReinstall,
    registerWaylandRestartTarget,
    resetWaylandRestartWatch,
    scheduleWaylandRestartCheck,
    unregisterWaylandRestartTarget,
    WATCHER_REINSTALL_DELAY_MS,
    WATCHER_REINSTALL_MAX_ATTEMPTS,
    waylandRestartTargets,
    waylandWatcherInstalled,
} from './waylandRestartWatch.js';

const watchMock = fs.watch as unknown as ReturnType<typeof vi.fn>;

/** Longer than the 500 ms debounce window. */
const DEBOUNCE_SETTLE_MS = 700;
const settle = () => new Promise((r) => setTimeout(r, DEBOUNCE_SETTLE_MS));

describe('waylandRestartWatch', () => {
    let tmp: string;
    let sock: string;
    let prevRuntime: string | undefined;

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-wl-watch-'));
        sock = path.join(tmp, 'wayland-1');
        fs.writeFileSync(sock, '');
        prevRuntime = process.env.XDG_RUNTIME_DIR;
        process.env.XDG_RUNTIME_DIR = tmp;
        resetWaylandRestartWatch();
    });

    afterEach(() => {
        resetWaylandRestartWatch();
        fs.rmSync(tmp, { recursive: true, force: true });
        if (prevRuntime !== undefined) process.env.XDG_RUNTIME_DIR = prevRuntime;
        else delete process.env.XDG_RUNTIME_DIR;
    });

    /** Replace the socket the way a compositor restart does — new inode. */
    function replaceSocket(): void {
        fs.unlinkSync(sock);
        fs.writeFileSync(sock, '');
    }

    it('tracks registered targets and drops them on unregister', () => {
        const a = {};
        const b = {};
        registerWaylandRestartTarget(a, vi.fn());
        registerWaylandRestartTarget(b, vi.fn());
        expect(waylandRestartTargets().size).toBe(2);
        unregisterWaylandRestartTarget(a);
        expect(waylandRestartTargets().size).toBe(1);
        expect([...waylandRestartTargets()]).toEqual([b]);
    });

    it('re-registering the same target keeps one entry (restart re-arms it)', () => {
        const a = {};
        registerWaylandRestartTarget(a, vi.fn());
        registerWaylandRestartTarget(a, vi.fn());
        expect(waylandRestartTargets().size).toBe(1);
    });

    it('notifies every target with the new ident when the socket inode changes', async () => {
        const first = vi.fn();
        const second = vi.fn();
        registerWaylandRestartTarget({}, first);
        registerWaylandRestartTarget({}, second);

        replaceSocket();
        scheduleWaylandRestartCheck();
        await settle();

        expect(first).toHaveBeenCalledTimes(1);
        expect(second).toHaveBeenCalledTimes(1);
        // `<filename>:<inode>` — the inode is what proves it's a new compositor.
        expect(first.mock.calls[0][0]).toMatch(/^wayland-1:\d+$/);
    });

    it('ignores a spurious event when the session is unchanged', async () => {
        const handler = vi.fn();
        registerWaylandRestartTarget({}, handler);
        scheduleWaylandRestartCheck();
        await settle();
        expect(handler).not.toHaveBeenCalled();
    });

    it('waits for the next event while no socket is present (mid-restart)', async () => {
        const handler = vi.fn();
        registerWaylandRestartTarget({}, handler);
        fs.unlinkSync(sock);
        scheduleWaylandRestartCheck();
        await settle();
        expect(handler).not.toHaveBeenCalled();
    });

    it('debounces a delete+create burst into a single notification', async () => {
        const handler = vi.fn();
        registerWaylandRestartTarget({}, handler);
        replaceSocket();
        scheduleWaylandRestartCheck();
        scheduleWaylandRestartCheck();
        scheduleWaylandRestartCheck();
        await settle();
        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('does not notify a target that unregistered before the check fired', async () => {
        const handler = vi.fn();
        const target = {};
        registerWaylandRestartTarget(target, handler);
        replaceSocket();
        scheduleWaylandRestartCheck();
        unregisterWaylandRestartTarget(target);
        await settle();
        expect(handler).not.toHaveBeenCalled();
    });

    it('reset drops every registration and the pending debounce', async () => {
        const handler = vi.fn();
        registerWaylandRestartTarget({}, handler);
        replaceSocket();
        scheduleWaylandRestartCheck();
        resetWaylandRestartWatch();
        await settle();
        expect(waylandRestartTargets().size).toBe(0);
        expect(handler).not.toHaveBeenCalled();
    });

    it('registering without a runtime dir is a no-op, not a throw', () => {
        resetWaylandRestartWatch();
        delete process.env.XDG_RUNTIME_DIR;
        expect(() => registerWaylandRestartTarget({}, vi.fn())).not.toThrow();
        expect(waylandRestartTargets().size).toBe(1);
    });
});

describe('isWaylandSocketEvent', () => {
    it('accepts the compositor sockets and their lock files', () => {
        // The `.lock` write/remove is part of the restart burst we watch for,
        // hence a PREFIX match rather than an exact one.
        for (const name of ['wayland-0', 'wayland-1', 'wayland-1.lock', 'wayland-12']) {
            expect(isWaylandSocketEvent(name), name).toBe(true);
        }
        expect(isWaylandSocketEvent(Buffer.from('wayland-1'))).toBe(true);
    });

    it('rejects everything else the runtime dir carries', () => {
        for (const name of ['pulse', 'bus', 'systemd', 'wayland', 'wayland-', 'my-wayland-1']) {
            expect(isWaylandSocketEvent(name), name).toBe(false);
        }
        // fs.watch gives no filename on some platforms/events.
        expect(isWaylandSocketEvent(null)).toBe(false);
        expect(isWaylandSocketEvent(undefined)).toBe(false);
        expect(isWaylandSocketEvent('')).toBe(false);
    });
});

describe('planWatcherReinstall', () => {
    it('reinstalls while targets are still registered and the budget holds', () => {
        expect(planWatcherReinstall(1, 0)).toBe(true);
        expect(planWatcherReinstall(3, WATCHER_REINSTALL_MAX_ATTEMPTS - 1)).toBe(true);
    });

    it('gives up with no targets left — nothing to self-heal for', () => {
        expect(planWatcherReinstall(0, 0)).toBe(false);
    });

    it('gives up once the per-outage budget is spent (a dead runtime dir must not spin)', () => {
        expect(planWatcherReinstall(1, WATCHER_REINSTALL_MAX_ATTEMPTS)).toBe(false);
    });
});

/**
 * The watcher-error path. A real inotify watch can't be made to error on
 * demand, so `fs.watch` is swapped for a fake FSWatcher whose `error` event we
 * emit ourselves. Before the fix this path dropped the watcher and left every
 * target registered — compositor-restart self-heal silently gone for the rest
 * of the engine session.
 */
describe('watcher error → reinstall', () => {
    class FakeWatcher extends EventEmitter {
        closed = false;
        close(): void {
            this.closed = true;
        }
    }

    let tmp: string;
    let sock: string;
    let prevRuntime: string | undefined;
    let realWatch: unknown;
    let fakes: FakeWatcher[];

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-wl-watch-err-'));
        sock = path.join(tmp, 'wayland-1');
        fs.writeFileSync(sock, '');
        prevRuntime = process.env.XDG_RUNTIME_DIR;
        process.env.XDG_RUNTIME_DIR = tmp;
        resetWaylandRestartWatch();
        realWatch = watchMock.getMockImplementation();
        fakes = [];
        watchMock.mockImplementation(() => {
            const w = new FakeWatcher();
            fakes.push(w);
            return w;
        });
        // Call counts are per-test here — the mock is module-level.
        watchMock.mockClear();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        resetWaylandRestartWatch();
        watchMock.mockImplementation(realWatch as never);
        fs.rmSync(tmp, { recursive: true, force: true });
        if (prevRuntime !== undefined) process.env.XDG_RUNTIME_DIR = prevRuntime;
        else delete process.env.XDG_RUNTIME_DIR;
    });

    it('puts a fresh watcher up after the errored one is dropped', () => {
        registerWaylandRestartTarget({}, vi.fn());
        expect(waylandWatcherInstalled()).toBe(true);

        fakes[0].emit('error', new Error('EBADF'));
        // Dropped immediately — fs.watch has already closed it.
        expect(fakes[0].closed).toBe(true);
        expect(waylandWatcherInstalled()).toBe(false);

        vi.advanceTimersByTime(WATCHER_REINSTALL_DELAY_MS);
        expect(waylandWatcherInstalled()).toBe(true);
        expect(watchMock).toHaveBeenCalledTimes(2);
    });

    it('notifies targets of a compositor restart that happened DURING the outage', () => {
        const handler = vi.fn();
        registerWaylandRestartTarget({}, handler);
        fakes[0].emit('error', new Error('EBADF'));
        // The event we would otherwise have missed: new socket, new inode.
        fs.unlinkSync(sock);
        fs.writeFileSync(sock, '');

        vi.advanceTimersByTime(WATCHER_REINSTALL_DELAY_MS);
        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler.mock.calls[0][0]).toMatch(/^wayland-1:\d+$/);
    });

    it('stays quiet when the same session is still there after the reinstall', () => {
        const handler = vi.fn();
        registerWaylandRestartTarget({}, handler);
        fakes[0].emit('error', new Error('EBADF'));
        vi.advanceTimersByTime(WATCHER_REINSTALL_DELAY_MS);
        expect(waylandWatcherInstalled()).toBe(true);
        expect(handler).not.toHaveBeenCalled();
    });

    it('does not reinstall once every target has unregistered', () => {
        const target = {};
        registerWaylandRestartTarget(target, vi.fn());
        fakes[0].emit('error', new Error('EBADF'));
        unregisterWaylandRestartTarget(target);
        vi.advanceTimersByTime(WATCHER_REINSTALL_DELAY_MS * 5);
        expect(watchMock).toHaveBeenCalledTimes(1);
        expect(waylandWatcherInstalled()).toBe(false);
    });

    it('keeps retrying a runtime dir that stays unwatchable, then stops', () => {
        registerWaylandRestartTarget({}, vi.fn());
        expect(watchMock).toHaveBeenCalledTimes(1);
        fakes[0].emit('error', new Error('EBADF'));
        // Every reinstall attempt throws, as it would while the dir is gone.
        watchMock.mockImplementation(() => {
            throw new Error('ENOENT');
        });
        vi.advanceTimersByTime(WATCHER_REINSTALL_DELAY_MS * (WATCHER_REINSTALL_MAX_ATTEMPTS + 5));
        // Budget spent — bounded, not an endless respawn loop.
        expect(watchMock).toHaveBeenCalledTimes(1 + WATCHER_REINSTALL_MAX_ATTEMPTS);
        expect(waylandWatcherInstalled()).toBe(false);
        // A later register (module restart) gets a fresh budget.
        watchMock.mockImplementation(() => {
            const w = new FakeWatcher();
            fakes.push(w);
            return w;
        });
        registerWaylandRestartTarget({}, vi.fn());
        expect(waylandWatcherInstalled()).toBe(true);
    });
});
