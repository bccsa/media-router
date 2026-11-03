import { describe, it, expect, vi, afterEach } from 'vitest';
import { setLogTap } from '@media-router/shared-types';
import { PipeWireManager } from './PipeWireManager.js';

/**
 * B-195: pipewire-pulse drops every PA module when it restarts and hands the same IDs to the
 * next loads (a private daemon on the dev Pi gave 536870912 before and after). A module that
 * unloads its old ID after a restart must not take another module's fresh one with it.
 */
function fakePulse() {
    const modules = new Map<number, string>();
    let next = 536870912;
    /** PipeWire answers; `hiccups` listings fail while it does (a pactl timeout). */
    const pulse = { up: true, hiccups: 0 };
    const refused = () => new Error('pactl command failed\nConnection failure: Connection refused');
    const exec = vi.fn(async (args: string[]) => {
        if (!pulse.up) throw refused();
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
    const listing = (args: string[]) => {
        if (args.join(' ') !== 'list short modules') return '';
        return [...modules].map(([id, line]) => `${id}\t${line}\t`).join('\n');
    };
    const execImmediateAsync = vi.fn(async (args: string[]) => {
        if (!pulse.up || pulse.hiccups-- > 0) throw refused();
        return listing(args);
    });
    const restart = () => {
        modules.clear();
        next = 536870912;
    };
    const pw = new PipeWireManager({
        exec,
        execImmediateAsync,
        onMutation: null,
    } as never);
    return { pw, modules, pulse, exec, execImmediateAsync, restart };
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
    it('a listing that gets no answer still unloads: a pactl hiccup leaves nothing loaded', async () => {
        const { pw, modules, pulse, exec } = fakePulse();
        const id = await pw.loadRemapSource('ain-1', 'alsa_input.mic', 2, 48000, 'ain-1');
        pulse.hiccups = 1;
        await pw.unloadModule(id, 'MR_PW_ain-1');
        expect(unloaded(exec)).toEqual([id]);
        expect(modules.size).toBe(0);
    });

    describe('log lines', () => {
        const lines: Array<{ level: number; name: string; msg: string }> = [];
        const flush = () => new Promise((r) => setImmediate(r));
        afterEach(() => {
            setLogTap(null);
            lines.length = 0;
        });

        it('PipeWire gone: the unload is tried, and its failure is a line, not a warning', async () => {
            setLogTap((l) => lines.push(JSON.parse(l)));
            const { pw, pulse, exec } = fakePulse();
            const id = await pw.loadRemapSink('aout-1', 'alsa_output.dac', 2, 48000, 'aout-1');
            pulse.up = false;
            await pw.releaseAll('aout-1');
            await flush();
            expect(unloaded(exec)).toEqual([id]);
            const mine = lines.filter((l) => l.name === 'PipeWireManager');
            expect(mine.filter((l) => l.level >= 40)).toEqual([]);
            expect(mine.map((l) => l.msg)).toContain(
                'PA module not unloaded: PipeWire does not answer',
            );
        });

        it('an ID left alone after a restart is a line of PipeWireManager naming the node', async () => {
            setLogTap((l) => lines.push(JSON.parse(l)));
            const { pw, restart } = fakePulse();
            const old = await pw.loadRemapSource('ain-1', 'alsa_input.mic', 2, 48000, 'ain-1');
            restart();
            await pw.unloadModule(old, 'MR_PW_ain-1');
            await flush();
            const line = lines.find((l) => l.msg.startsWith('PA module is gone or no longer ours'));
            expect(line).toMatchObject({ name: 'PipeWireManager', node: 'MR_PW_ain-1', level: 30 });
        });

        it('PipeWire answers: a failed unload of its own module is still a warning', async () => {
            setLogTap((l) => lines.push(JSON.parse(l)));
            const { pw, exec } = fakePulse();
            const id = await pw.loadRemapSink('aout-1', 'alsa_output.dac', 2, 48000, 'aout-1');
            exec.mockImplementationOnce(async () => {
                throw new Error('pactl command failed\nFailure: Timeout');
            });
            await pw.unloadModule(id, 'MR_PW_aout-1');
            await flush();
            const warned = lines.filter((l) => l.name === 'PipeWireManager' && l.level === 40);
            expect(warned.map((l) => l.msg)).toEqual(['Failed to unload module']);
        });
    });

    it('asks for the listing without blocking on the stop path', async () => {
        const { pw, exec, execImmediateAsync } = fakePulse();
        const a = await pw.loadNullSink('mix_in_1', 2, 48000, 'mix');
        const b = await pw.loadNullSink('mix_in_2', 2, 48000, 'mix');
        await pw.releaseAll('mix');
        expect(unloaded(exec)).toEqual([a, b]);
        expect(execImmediateAsync).toHaveBeenCalledTimes(2);
        expect(execImmediateAsync).toHaveBeenCalledWith(['list', 'short', 'modules']);
    });
});

describe('PipeWireManager: every pactl read is asked without blocking (B-200)', () => {
    it('the orphan cleanup unloads every MR_PW_ module from an asked listing', async () => {
        const { pw, exec, execImmediateAsync } = fakePulse();
        const a = await pw.loadNullSink('mix_in_1', 2, 48000);
        const b = await pw.loadRemapSink('aout-1', 'alsa_output.dac', 2, 48000);
        await pw.cleanupOrphans();
        expect(unloaded(exec)).toEqual([a, b]);
        expect(execImmediateAsync).toHaveBeenCalledWith(['list', 'short', 'modules']);
    });

    it('waiting for a sink or a source polls an asked listing until the node is there', async () => {
        const answers = ['', '1\tMR_PW_ain-1\tPipeWire\ts16le 2ch 48000Hz\tSUSPENDED'];
        const execImmediateAsync = vi.fn(async () => answers.shift() ?? answers[0] ?? '');
        const pw = new PipeWireManager({
            exec: vi.fn(),
            execImmediateAsync,
            onMutation: null,
        } as never);
        expect(await pw.waitForSource('MR_PW_ain-1', 2000, 1)).toBe(true);
        expect(execImmediateAsync).toHaveBeenCalledTimes(2);
        expect(execImmediateAsync).toHaveBeenCalledWith(['list', 'short', 'sources']);
        const none = vi.fn(async () => '');
        const pw2 = new PipeWireManager({
            exec: vi.fn(),
            execImmediateAsync: none,
            onMutation: null,
        } as never);
        expect(await pw2.waitForSink('MR_PW_aout-1', 30, 5)).toBe(false);
        expect(none).toHaveBeenCalledWith(['list', 'short', 'sinks']);
    });
});
