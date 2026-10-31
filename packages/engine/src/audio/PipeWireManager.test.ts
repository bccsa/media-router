import { describe, it, expect, vi } from 'vitest';
import { PipeWireManager } from './PipeWireManager.js';

/**
 * B-195: pipewire-pulse drops every PA module when it restarts and hands the same IDs to the
 * next loads (a private daemon on the dev Pi gave 536870912 before and after). A module that
 * unloads its old ID after a restart must not take another module's fresh one with it.
 */
function fakePulse() {
    const modules = new Map<number, string>();
    let next = 536870912;
    const exec = vi.fn(async (args: string[]) => {
        if (args[0] === 'load-module') {
            const id = next++;
            modules.set(id, `${args[1]}\t${args.slice(2).join(' ')}`);
            return String(id);
        }
        if (args[0] === 'unload-module') {
            if (!modules.delete(Number(args[1]))) throw new Error('Failure: No such entity');
            return '';
        }
        return '';
    });
    const execImmediate = vi.fn((args: string[]) => {
        if (args.join(' ') !== 'list short modules') return '';
        return [...modules].map(([id, line]) => `${id}\t${line}\t`).join('\n');
    });
    const restart = () => {
        modules.clear();
        next = 536870912;
    };
    const pw = new PipeWireManager({ exec, execImmediate, onMutation: null } as never);
    return { pw, modules, exec, restart };
}

const unloaded = (exec: ReturnType<typeof fakePulse>['exec']) =>
    exec.mock.calls.filter((c) => c[0][0] === 'unload-module').map((c) => Number(c[0][1]));

describe('PipeWireManager: a PA module is unloaded only while its ID still names it (B-195)', () => {
    it('unloads its own module by name', async () => {
        const { pw, modules, exec } = fakePulse();
        const id = await pw.loadRemapSource('ain-1', 'alsa_input.mic', 2, 48000, 'ain-1');
        await pw.unloadModule(id, 'MR_PW_ain-1');
        expect(unloaded(exec)).toEqual([id]);
        expect(modules.size).toBe(0);
    });

    it('after a restart, leaves the ID alone when it is gone or another module holds it', async () => {
        const { pw, modules, exec, restart } = fakePulse();
        const old = await pw.loadRemapSource('ain-1', 'alsa_input.mic', 2, 48000, 'ain-1');
        restart();
        await pw.unloadModule(old, 'MR_PW_ain-1'); // gone
        const theirs = await pw.loadRemapSink('aout-1', 'alsa_output.dac', 2, 48000, 'aout-1');
        expect(theirs).toBe(old);
        await pw.unloadModule(old, 'MR_PW_ain-1'); // now the output's remap-sink
        expect(unloaded(exec)).toEqual([]);
        expect([...modules.values()][0]).toContain('sink_name=MR_PW_aout-1');
    });

    it('releaseAll after a restart unloads what the owner loaded since, nothing of the others', async () => {
        const { pw, modules, exec, restart } = fakePulse();
        await pw.loadRemapSource('ain-1', 'alsa_input.mic', 2, 48000, 'ain-1');
        restart();
        await pw.loadRemapSink('aout-1', 'alsa_output.dac', 2, 48000, 'aout-1'); // the old ID
        const mine = await pw.loadRemapSource('ain-1', 'alsa_input.mic', 2, 48000, 'ain-1');
        await pw.releaseAll('ain-1');
        expect(unloaded(exec)).toEqual([mine]);
        expect([...modules.values()].map((l) => l.split('\t')[0])).toEqual(['module-remap-sink']);
    });

    it('a name that is a prefix of another module name does not match it', async () => {
        const { pw, exec } = fakePulse();
        const id = await pw.loadNullSink('mix_in_1', 2, 48000, 'mix');
        await pw.unloadModule(id, 'MR_PW_mix');
        expect(unloaded(exec)).toEqual([]);
        await pw.unloadModule(id, 'MR_PW_mix_in_1');
        expect(unloaded(exec)).toEqual([id]);
    });
});
