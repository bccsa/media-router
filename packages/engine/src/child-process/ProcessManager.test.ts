import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ProcessManager } from './ProcessManager.js';

describe('ProcessManager', () => {
    let pm: ProcessManager;

    afterEach(async () => {
        if (pm) await pm.killAll();
    });

    beforeEach(() => {
        pm = new ProcessManager();
    });

    it('spawns a process and tracks ownership', () => {
        const proc = pm.spawn('owner-1', {
            label: 'test',
            command: 'sleep',
            args: ['60'],
            autoRestart: false,
        });

        // Process starts synchronously via spawn()
        expect(pm.activeCount).toBe(1);
        expect(pm.list('owner-1')).toHaveLength(1);
        expect(pm.list('owner-1')[0].label).toBe('test');
    });

    it('spawns multiple processes for one owner', () => {
        pm.spawn('owner-1', { label: 'a', command: 'sleep', args: ['60'], autoRestart: false });
        pm.spawn('owner-1', { label: 'b', command: 'sleep', args: ['60'], autoRestart: false });
        pm.spawn('owner-1', { label: 'c', command: 'sleep', args: ['60'], autoRestart: false });

        expect(pm.activeCount).toBe(3);
        expect(pm.list('owner-1')).toHaveLength(3);
    });

    it('tracks ownership per module', () => {
        pm.spawn('owner-1', { label: 'a', command: 'sleep', args: ['60'], autoRestart: false });
        pm.spawn('owner-2', { label: 'b', command: 'sleep', args: ['60'], autoRestart: false });

        expect(pm.list('owner-1')).toHaveLength(1);
        expect(pm.list('owner-2')).toHaveLength(1);
        expect(pm.activeCount).toBe(2);
    });

    it('releaseAll kills all processes for one owner', async () => {
        pm.spawn('owner-1', { label: 'a', command: 'sleep', args: ['60'], autoRestart: false });
        pm.spawn('owner-1', { label: 'b', command: 'sleep', args: ['60'], autoRestart: false });
        pm.spawn('owner-2', { label: 'c', command: 'sleep', args: ['60'], autoRestart: false });

        await new Promise((r) => setTimeout(r, 100)); // let processes spawn

        await pm.releaseAll('owner-1');

        expect(pm.list('owner-1')).toHaveLength(0);
        expect(pm.list('owner-2')).toHaveLength(1); // owner-2 untouched
        expect(pm.activeCount).toBe(1);
    });

    it('killAll kills everything', async () => {
        pm.spawn('owner-1', { label: 'a', command: 'sleep', args: ['60'], autoRestart: false });
        pm.spawn('owner-2', { label: 'b', command: 'sleep', args: ['60'], autoRestart: false });

        await new Promise((r) => setTimeout(r, 100));

        await pm.killAll();

        expect(pm.activeCount).toBe(0);
        expect(pm.list('owner-1')).toHaveLength(0);
        expect(pm.list('owner-2')).toHaveLength(0);
    });

    it('kill removes a specific process', async () => {
        const proc = pm.spawn('owner-1', { label: 'target', command: 'sleep', args: ['60'], autoRestart: false });
        pm.spawn('owner-1', { label: 'keep', command: 'sleep', args: ['60'], autoRestart: false });

        await new Promise((r) => setTimeout(r, 100));

        await pm.kill('owner-1', proc);

        expect(pm.list('owner-1')).toHaveLength(1);
        expect(pm.list('owner-1')[0].label).toBe('keep');
    });

    it('getActivePids returns running PIDs', async () => {
        pm.spawn('owner-1', { label: 'a', command: 'sleep', args: ['60'], autoRestart: false });
        pm.spawn('owner-1', { label: 'b', command: 'sleep', args: ['60'], autoRestart: false });

        await new Promise((r) => setTimeout(r, 200)); // let processes spawn

        const pids = pm.getActivePids();
        expect(pids.length).toBeGreaterThanOrEqual(1); // at least some should be running
        for (const pid of pids) {
            expect(pid).toBeGreaterThan(0);
        }
    });

    it('list returns empty for unknown owner', () => {
        expect(pm.list('nonexistent')).toEqual([]);
    });

    it('releaseAll is safe for unknown owner', async () => {
        await expect(pm.releaseAll('nonexistent')).resolves.toBeUndefined();
    });

    it('killAll is safe when empty', async () => {
        await expect(pm.killAll()).resolves.toBeUndefined();
    });
});
