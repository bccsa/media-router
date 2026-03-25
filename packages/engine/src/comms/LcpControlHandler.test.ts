import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { LcpControlHandler } from './LcpControlHandler.js';

/** Minimal mock for LcpServer. */
class MockLcpServer extends EventEmitter {
    broadcastConfigUpdate = vi.fn();
    broadcastConfigUpdateExcept = vi.fn();
}

/** Minimal mock for ManagerConnection. */
class MockManagerConnection {
    send = vi.fn();
}

/** Minimal mock for ModuleManager. */
class MockModuleManager {
    applyConfigUpdate = vi.fn().mockResolvedValue(undefined);
}

/** Minimal mock for CommandDispatcher. */
class MockCommandDispatcher {
    dispatch = vi.fn();
}

describe('LcpControlHandler', () => {
    let lcpServer: MockLcpServer;
    let managerConnection: MockManagerConnection;
    let moduleManager: MockModuleManager;
    let commandDispatcher: MockCommandDispatcher;
    let handler: LcpControlHandler;

    beforeEach(() => {
        vi.useFakeTimers();
        lcpServer = new MockLcpServer();
        managerConnection = new MockManagerConnection();
        moduleManager = new MockModuleManager();
        commandDispatcher = new MockCommandDispatcher();
        handler = new LcpControlHandler({
            lcpServer: lcpServer as any,
            managerConnection: managerConnection as any,
            moduleManager: moduleManager as any,
            commandDispatcher: commandDispatcher as any,
        });
    });

    // --- Volume ---

    it('volume: applies locally', () => {
        lcpServer.emit('control', { action: 'volume', moduleId: 'mic-1', volume: 75 });
        expect(moduleManager.applyConfigUpdate).toHaveBeenCalledWith('mic-1', { volume: 75 });
    });

    it('volume: broadcasts to other LCPs (skip sender)', () => {
        lcpServer.emit('control', { action: 'volume', moduleId: 'mic-1', volume: 75, _socketId: 'socket-A' });
        expect(lcpServer.broadcastConfigUpdateExcept).toHaveBeenCalledWith(
            'socket-A',
            [{ op: 'replace', path: '/modules/mic-1/settings/volume', value: 75 }],
        );
    });

    it('volume: broadcasts to all LCPs when no sender', () => {
        lcpServer.emit('control', { action: 'volume', moduleId: 'mic-1', volume: 75 });
        expect(lcpServer.broadcastConfigUpdate).toHaveBeenCalledWith(
            [{ op: 'replace', path: '/modules/mic-1/settings/volume', value: 75 }],
        );
    });

    it('volume: debounced forward to manager (100ms)', () => {
        lcpServer.emit('control', { action: 'volume', moduleId: 'mic-1', volume: 50 });
        expect(managerConnection.send).not.toHaveBeenCalled();
        vi.advanceTimersByTime(100);
        expect(managerConnection.send).toHaveBeenCalledWith('lcpConfig', { moduleId: 'mic-1', changes: { volume: 50 } });
    });

    it('volume: rapid changes only send last value to manager', () => {
        lcpServer.emit('control', { action: 'volume', moduleId: 'mic-1', volume: 50 });
        lcpServer.emit('control', { action: 'volume', moduleId: 'mic-1', volume: 60 });
        lcpServer.emit('control', { action: 'volume', moduleId: 'mic-1', volume: 70 });
        vi.advanceTimersByTime(100);
        expect(managerConnection.send).toHaveBeenCalledTimes(1);
        expect(managerConnection.send).toHaveBeenCalledWith('lcpConfig', { moduleId: 'mic-1', changes: { volume: 70 } });
    });

    // --- Mute ---

    it('mute: applies audioEnabled=false locally', () => {
        lcpServer.emit('control', { action: 'mute', moduleId: 'mic-1', muted: true });
        expect(moduleManager.applyConfigUpdate).toHaveBeenCalledWith('mic-1', { audioEnabled: false });
    });

    it('unmute: applies audioEnabled=true locally', () => {
        lcpServer.emit('control', { action: 'mute', moduleId: 'mic-1', muted: false });
        expect(moduleManager.applyConfigUpdate).toHaveBeenCalledWith('mic-1', { audioEnabled: true });
    });

    it('mute: broadcasts to other LCPs', () => {
        lcpServer.emit('control', { action: 'mute', moduleId: 'mic-1', muted: true, _socketId: 'socket-B' });
        expect(lcpServer.broadcastConfigUpdateExcept).toHaveBeenCalledWith(
            'socket-B',
            [{ op: 'replace', path: '/modules/mic-1/settings/audioEnabled', value: false }],
        );
    });

    it('mute: debounced forward to manager', () => {
        lcpServer.emit('control', { action: 'mute', moduleId: 'mic-1', muted: true });
        vi.advanceTimersByTime(100);
        expect(managerConnection.send).toHaveBeenCalledWith('lcpConfig', { moduleId: 'mic-1', changes: { audioEnabled: false } });
    });

    // --- Start/Stop ---

    it('start: dispatches command and notifies manager', () => {
        lcpServer.emit('control', { action: 'start' });
        expect(commandDispatcher.dispatch).toHaveBeenCalledWith({ command: 'start' });
        expect(managerConnection.send).toHaveBeenCalledWith('lcpEngineCommand', { command: 'start' });
    });

    it('stop: dispatches command and notifies manager', () => {
        lcpServer.emit('control', { action: 'stop' });
        expect(commandDispatcher.dispatch).toHaveBeenCalledWith({ command: 'stop' });
        expect(managerConnection.send).toHaveBeenCalledWith('lcpEngineCommand', { command: 'stop' });
    });

    // --- Unknown ---

    it('unknown action: forwards to manager', () => {
        lcpServer.emit('control', { action: 'unknown', data: 123 });
        expect(managerConnection.send).toHaveBeenCalledWith('control', { action: 'unknown', data: 123 });
    });

    // --- Destroy ---

    it('destroy clears debounce timers', () => {
        lcpServer.emit('control', { action: 'volume', moduleId: 'mic-1', volume: 50 });
        handler.destroy();
        vi.advanceTimersByTime(200);
        expect(managerConnection.send).not.toHaveBeenCalled(); // timer was cleared
    });

    // --- Multiple modules debounce independently ---

    it('debounce is per-module', () => {
        lcpServer.emit('control', { action: 'volume', moduleId: 'mic-1', volume: 50 });
        lcpServer.emit('control', { action: 'volume', moduleId: 'mic-2', volume: 80 });
        vi.advanceTimersByTime(100);
        expect(managerConnection.send).toHaveBeenCalledTimes(2);
        expect(managerConnection.send).toHaveBeenCalledWith('lcpConfig', { moduleId: 'mic-1', changes: { volume: 50 } });
        expect(managerConnection.send).toHaveBeenCalledWith('lcpConfig', { moduleId: 'mic-2', changes: { volume: 80 } });
    });
});
