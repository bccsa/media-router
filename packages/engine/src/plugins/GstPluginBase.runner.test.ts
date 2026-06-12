import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { GstPluginBase } from './GstPluginBase.js';
import type { PipelineDescription, ModuleServices } from './PluginModule.js';
import type { ManagedProcess, ManagedProcessOptions } from '../child-process/ManagedProcess.js';

class FakeProc extends EventEmitter {
    destroyed = false;
}

class TestModule extends GstPluginBase {
    buildPipeline(): PipelineDescription | null {
        return null;
    }
    spawn(opts: ManagedProcessOptions & { clearBadges?: string[] }): ManagedProcess {
        return this.spawnRunnerProcess(opts);
    }
    addBadge(id: string): void {
        this.setBadge(id, { text: 'x' });
    }
    setRunning(v: boolean): void {
        this.running = v;
    }
}

function makeModule() {
    const proc = new FakeProc();
    const spawn = vi.fn(() => proc);
    const module = new TestModule();
    void module.onInit({}, {
        instanceId: 'm1',
        processManager: { spawn },
    } as unknown as ModuleServices);
    module.setRunning(true);
    return { module, proc, spawn };
}

const badgeIds = (m: TestModule) => m.getState().badges.map((b) => b.id);

beforeEach(() => vi.clearAllMocks());

describe('GstPluginBase.spawnRunnerProcess health wiring', () => {
    it('spawns via ProcessManager under the module instance id', () => {
        const { module, spawn } = makeModule();
        module.spawn({ label: 'runner', command: 'x' });
        expect(spawn).toHaveBeenCalledWith(
            'm1',
            expect.objectContaining({ label: 'runner', command: 'x' }),
        );
        // The badge list is local wiring — never forwarded to ProcessManager.
        expect(spawn.mock.calls[0]![1]).not.toHaveProperty('clearBadges');
    });

    it("'restarting' → warning health and stats badges cleared", () => {
        const { module, proc } = makeModule();
        module.addBadge('bitrate');
        module.spawn({ label: 'runner', command: 'x', clearBadges: ['bitrate'] });
        proc.emit('restarting', 3, 9000);
        expect(module.getState().health).toBe('warning');
        expect(module.getState().error).toContain('attempt 3');
        expect(badgeIds(module)).not.toContain('bitrate');
    });

    it("'error' (spawn failure / attempts exhausted) → error health", () => {
        const { module, proc } = makeModule();
        module.spawn({ label: 'runner', command: 'x' });
        proc.emit('error', 'exceeded max restart attempts');
        expect(module.getState().health).toBe('error');
        expect(module.getState().error).toContain('max restart attempts');
    });

    it('unexpected clean exit → warning (e.g. VOD stream ran out)', () => {
        const { module, proc } = makeModule();
        module.spawn({ label: 'runner', command: 'x' });
        proc.emit('stopped', 0, null);
        expect(module.getState().health).toBe('warning');
        expect(module.getState().error).toContain('exited');
    });

    it('deliberate kill (destroyed) and stopped-module exits are not health events', () => {
        const { module, proc } = makeModule();
        module.addBadge('bitrate');
        module.spawn({ label: 'runner', command: 'x', clearBadges: ['bitrate'] });

        proc.destroyed = true;
        proc.emit('stopped', 0, null);
        expect(module.getState().health).not.toBe('warning');
        expect(badgeIds(module)).toContain('bitrate');

        proc.destroyed = false;
        module.setRunning(false);
        proc.emit('stopped', 0, null);
        proc.emit('restarting', 1, 3000);
        expect(module.getState().health).not.toBe('warning');
    });

    it('crash exit (non-zero) defers to the restarting/error events', () => {
        const { module, proc } = makeModule();
        module.spawn({ label: 'runner', command: 'x' });
        proc.emit('stopped', 1, null);
        // No warning yet — ManagedProcess emits 'restarting' (or 'error') next.
        expect(module.getState().health).not.toBe('warning');
    });

    it('throws when the processManager service is unavailable', () => {
        const module = new TestModule();
        expect(() => module.spawn({ label: 'r', command: 'x' })).toThrow(/processManager/);
    });
});
