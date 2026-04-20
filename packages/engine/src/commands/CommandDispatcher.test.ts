import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommandDispatcher, type CommandContext } from './CommandDispatcher.js';

function createMockContext(): CommandContext {
    return {
        moduleManager: {
            size: 0,
            get: vi.fn().mockReturnValue(undefined),
            applyConfigUpdate: vi.fn().mockResolvedValue(undefined),
            getAllStates: vi.fn().mockReturnValue({}),
        } as any,
        mediaRouter: {
            createConnection: vi.fn().mockResolvedValue('conn-1'),
            updateChannelMap: vi.fn().mockResolvedValue(undefined),
            removeConnection: vi.fn().mockResolvedValue(undefined),
        } as any,
        lcpServer: {
            broadcastConfigUpdate: vi.fn(),
        } as any,
        currentConfig: { modules: {}, connections: [] },
        startModules: vi.fn().mockResolvedValue(undefined),
        stopModules: vi.fn().mockResolvedValue(undefined),
        resetEngine: vi.fn().mockResolvedValue(undefined),
        restartModule: vi.fn().mockResolvedValue(undefined),
        startSingleModule: vi.fn().mockResolvedValue(undefined),
        deleteSingleModule: vi.fn().mockResolvedValue(undefined),
        disableModule: vi.fn().mockResolvedValue(undefined),
        enableModule: vi.fn().mockResolvedValue(undefined),
    };
}

/** Flush all microtasks so commandLock chains resolve. */
async function flush(): Promise<void> {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
}

describe('CommandDispatcher', () => {
    let ctx: CommandContext;
    let dispatcher: CommandDispatcher;

    beforeEach(() => {
        ctx = createMockContext();
        dispatcher = new CommandDispatcher(ctx);
    });

    describe('lifecycle commands', () => {
        it('dispatch start calls startModules', async () => {
            dispatcher.dispatch({ command: 'start' });
            await flush();
            expect(ctx.startModules).toHaveBeenCalledOnce();
        });

        it('dispatch stop calls stopModules', async () => {
            dispatcher.dispatch({ command: 'stop' });
            await flush();
            expect(ctx.stopModules).toHaveBeenCalledOnce();
        });

        it('dispatch reset calls resetEngine', async () => {
            dispatcher.dispatch({ command: 'reset' });
            await flush();
            expect(ctx.resetEngine).toHaveBeenCalledOnce();
        });

        it('rapid start/stop/start — only last pending runs after current finishes', async () => {
            // Make startModules slow so we can queue commands while it's busy
            let resolveStart!: () => void;
            (ctx.startModules as ReturnType<typeof vi.fn>).mockImplementationOnce(
                () =>
                    new Promise<void>((r) => {
                        resolveStart = r;
                    }),
            );

            dispatcher.dispatch({ command: 'start' }); // schedules → runLifecycle
            await flush(); // let the .then() fire so startModules is actually called

            expect(ctx.startModules).toHaveBeenCalledOnce(); // now running (slow)

            dispatcher.dispatch({ command: 'stop' }); // queued as pending
            dispatcher.dispatch({ command: 'start' }); // replaces pending

            expect(ctx.stopModules).not.toHaveBeenCalled();

            // First start finishes — pending 'start' should be evaluated
            // moduleManager.size is 0 (no running modules), so 'start' should execute
            resolveStart();
            await flush();

            // The first start ran, then the pending 'start' ran (not stopped, size=0)
            expect(ctx.startModules).toHaveBeenCalledTimes(2);
            expect(ctx.stopModules).not.toHaveBeenCalled();
        });

        it('isStopRequested reflects pendingLifecycle === stop', async () => {
            let resolveStart!: () => void;
            (ctx.startModules as ReturnType<typeof vi.fn>).mockReturnValueOnce(
                new Promise<void>((r) => {
                    resolveStart = r;
                }),
            );

            dispatcher.dispatch({ command: 'start' });
            expect(dispatcher.isStopRequested).toBe(false);

            dispatcher.dispatch({ command: 'stop' });
            expect(dispatcher.isStopRequested).toBe(true);

            resolveStart();
            await flush();
            // After execution, pending is cleared
            expect(dispatcher.isStopRequested).toBe(false);
        });

        it('runs pending start after stop (modules stopped = not running)', async () => {
            let resolveStop!: () => void;
            (ctx.stopModules as ReturnType<typeof vi.fn>).mockReturnValueOnce(
                new Promise<void>((r) => {
                    resolveStop = r;
                }),
            );

            // Modules exist (size=3) but after stop none are running
            (ctx.moduleManager as any).size = 3;
            (ctx.moduleManager.getAllStates as ReturnType<typeof vi.fn>).mockReturnValue({
                'mod-1': { running: false },
                'mod-2': { running: false },
                'mod-3': { running: false },
            });

            dispatcher.dispatch({ command: 'stop' }); // starts running
            dispatcher.dispatch({ command: 'start' }); // queued as pending

            resolveStop();
            await flush();

            expect(ctx.stopModules).toHaveBeenCalledOnce();
            expect(ctx.startModules).toHaveBeenCalledOnce(); // runs — no modules are actually running
        });

        it('skips pending start when modules are actually running', async () => {
            let resolveStop!: () => void;
            (ctx.stopModules as ReturnType<typeof vi.fn>).mockReturnValueOnce(
                new Promise<void>((r) => {
                    resolveStop = r;
                }),
            );

            // Modules still running (stop didn't work or different scenario)
            (ctx.moduleManager.getAllStates as ReturnType<typeof vi.fn>).mockReturnValue({
                'mod-1': { running: true },
            });

            dispatcher.dispatch({ command: 'stop' }); // starts running
            dispatcher.dispatch({ command: 'start' }); // queued as pending

            resolveStop();
            await flush();

            expect(ctx.stopModules).toHaveBeenCalledOnce();
            expect(ctx.startModules).not.toHaveBeenCalled(); // skipped — modules still running
        });

        it('skips pending stop when no modules are running', async () => {
            let resolveStart!: () => void;
            (ctx.startModules as ReturnType<typeof vi.fn>).mockReturnValueOnce(
                new Promise<void>((r) => {
                    resolveStart = r;
                }),
            );

            // No modules running
            (ctx.moduleManager.getAllStates as ReturnType<typeof vi.fn>).mockReturnValue({});

            dispatcher.dispatch({ command: 'start' }); // starts running
            dispatcher.dispatch({ command: 'stop' }); // queued as pending

            resolveStart();
            await flush();

            expect(ctx.startModules).toHaveBeenCalledOnce();
            expect(ctx.stopModules).not.toHaveBeenCalled(); // skipped — nothing running
        });
    });

    describe('moduleRestart', () => {
        it('restarts a running module', async () => {
            (ctx.moduleManager.get as ReturnType<typeof vi.fn>).mockReturnValue({ running: true });

            dispatcher.dispatch({ command: 'moduleRestart', moduleId: 'mod-1' });
            await flush();

            expect(ctx.restartModule).toHaveBeenCalledWith('mod-1');
        });

        it('starts a non-running module instead of restarting', async () => {
            (ctx.moduleManager.get as ReturnType<typeof vi.fn>).mockReturnValue({ running: false });

            dispatcher.dispatch({ command: 'moduleRestart', moduleId: 'mod-1' });
            await flush();

            expect(ctx.restartModule).not.toHaveBeenCalled();
            expect(ctx.startSingleModule).toHaveBeenCalledWith('mod-1');
        });

        it('skips restart for a module that does not exist', async () => {
            (ctx.moduleManager.get as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

            dispatcher.dispatch({ command: 'moduleRestart', moduleId: 'nonexistent' });
            await flush();

            expect(ctx.restartModule).not.toHaveBeenCalled();
        });
    });

    describe('moduleConfig', () => {
        it('applies config update and broadcasts to LCP', async () => {
            (ctx.moduleManager.get as ReturnType<typeof vi.fn>).mockReturnValue({ running: true });

            dispatcher.dispatch({
                command: 'moduleConfig',
                moduleId: 'mod-1',
                changes: { volume: 80 },
            });
            await flush();

            expect(ctx.moduleManager.applyConfigUpdate).toHaveBeenCalledWith('mod-1', {
                volume: 80,
            });
            expect(ctx.lcpServer.broadcastConfigUpdate).toHaveBeenCalledWith([
                { op: 'replace', path: '/modules/mod-1/settings/volume', value: 80 },
            ]);
        });

        it('skips config update when module not running', async () => {
            (ctx.moduleManager.get as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

            dispatcher.dispatch({
                command: 'moduleConfig',
                moduleId: 'mod-1',
                changes: { volume: 80 },
            });
            await flush();

            expect(ctx.moduleManager.applyConfigUpdate).not.toHaveBeenCalled();
        });
    });

    describe('module lifecycle commands', () => {
        it('moduleDelete calls deleteSingleModule', async () => {
            dispatcher.dispatch({ command: 'moduleDelete', moduleId: 'mod-1' });
            await flush();
            expect(ctx.deleteSingleModule).toHaveBeenCalledWith('mod-1');
        });

        it('moduleStart calls startSingleModule when module not running', async () => {
            (ctx.moduleManager.get as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
            dispatcher.dispatch({ command: 'moduleStart', moduleId: 'mod-1' });
            await flush();
            expect(ctx.startSingleModule).toHaveBeenCalledWith('mod-1');
        });

        it('moduleStart skips when module already running', async () => {
            (ctx.moduleManager.get as ReturnType<typeof vi.fn>).mockReturnValue({ running: true });
            dispatcher.dispatch({ command: 'moduleStart', moduleId: 'mod-1' });
            await flush();
            expect(ctx.startSingleModule).not.toHaveBeenCalled();
        });

        it('moduleDisable calls disableModule and broadcasts', async () => {
            dispatcher.dispatch({ command: 'moduleDisable', moduleId: 'mod-1' });
            await flush();
            expect(ctx.disableModule).toHaveBeenCalledWith('mod-1');
            expect(ctx.lcpServer.broadcastConfigUpdate).toHaveBeenCalledWith([
                { op: 'replace', path: '/modules/mod-1/enabled', value: false },
            ]);
        });

        it('moduleEnable calls enableModule and broadcasts', async () => {
            dispatcher.dispatch({ command: 'moduleEnable', moduleId: 'mod-1' });
            await flush();
            expect(ctx.enableModule).toHaveBeenCalledWith('mod-1');
            expect(ctx.lcpServer.broadcastConfigUpdate).toHaveBeenCalledWith([
                { op: 'replace', path: '/modules/mod-1/enabled', value: true },
            ]);
        });
    });

    describe('routing commands', () => {
        it('routingConnect creates connection and broadcasts', async () => {
            dispatcher.dispatch({
                command: 'routingConnect',
                sourceModuleId: 'mod-a',
                sourcePortId: 'out-0',
                sinkModuleId: 'mod-b',
                sinkPortId: 'in-0',
            });
            await flush();
            expect(ctx.mediaRouter.createConnection).toHaveBeenCalledWith(
                'mod-a',
                'out-0',
                'mod-b',
                'in-0',
                undefined,
            );
            expect(ctx.lcpServer.broadcastConfigUpdate).toHaveBeenCalled();
        });

        it('routingDisconnect removes connection and broadcasts', async () => {
            dispatcher.dispatch({ command: 'routingDisconnect', connectionId: 'conn-1' });
            await flush();
            expect(ctx.mediaRouter.removeConnection).toHaveBeenCalledWith('conn-1');
            expect(ctx.lcpServer.broadcastConfigUpdate).toHaveBeenCalledWith([
                { op: 'remove', path: '/connections/conn-1' },
            ]);
        });

        it('routingUpdate updates channel map', async () => {
            dispatcher.dispatch({
                command: 'routingUpdate',
                connectionId: 'conn-1',
                channelMap: [{ srcChannel: 0, dstChannel: 1 }],
            });
            await flush();
            expect(ctx.mediaRouter.updateChannelMap).toHaveBeenCalledWith('conn-1', [
                { srcChannel: 0, dstChannel: 1 },
            ]);
        });
    });

    it('unknown command does not throw', () => {
        expect(() => dispatcher.dispatch({ command: 'bogus' })).not.toThrow();
    });
});
