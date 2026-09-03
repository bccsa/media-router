import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FORCE_KILL_TIMEOUT_MS } from './PythonProcess.js';

/**
 * Teardown-drain contract: the Python runner EOS-drains a playing pipeline
 * before taking it to NULL, and every parent-side kill window is long enough
 * for that drain to finish.
 *
 * Why this is pinned and not just "code that looks right": stopping a pipeline
 * MID-DECODE wedges the Pi's stateless HEVC decoder (rpi-hevc-dec, kernel
 * 6.12) — hevc_d_stop_streaming → __vb2_queue_cancel waits forever on a
 * hardware completion that never comes, holding the videodev mutex, so every
 * later V4L2 open/close piles up in D state and the box needs a power cycle
 * (field incident, Pi 400, 2026-08). The kernel has no timeout there; the only
 * userspace defence is to never stop a decoder that is mid-frame. A shortened
 * kill window or a reordered teardown silently re-arms it, and nothing in a
 * unit test of either process alone would notice.
 *
 * The gst-level ordering proof (EOS actually reaches the sink before NULL,
 * real pipelines) lives in gst_drain_test.py — `pnpm --filter
 * @media-router/engine test:py`.
 */
const runnerSource = readFileSync(join(__dirname, 'gst-pipeline-runner.py'), 'utf8');
const gstRunnerSource = readFileSync(join(__dirname, 'GstRunner.ts'), 'utf8');
const gstChildProcessSource = readFileSync(join(__dirname, 'GstChildProcess.ts'), 'utf8');

/** Read a `NAME = 1234` literal out of a source file. */
function constantOf(source: string, name: string): number {
    const match = new RegExp(`${name}\\s*=\\s*(\\d[\\d_]*)`).exec(source);
    expect(match, `${name} not found`).toBeTruthy();
    return Number(match![1].replace(/_/g, ''));
}

/** Body of a python `def <name>(...)` up to the next top-level statement. */
function pythonFunctionBody(name: string): string {
    const start = runnerSource.indexOf(`def ${name}(`);
    expect(start, `def ${name} not found`).toBeGreaterThan(-1);
    const rest = runnerSource.slice(start);
    const end = rest.search(/\n(?=\S)/g);
    return end === -1 ? rest : rest.slice(0, end);
}

describe('EOS drain before teardown (runner ↔ parent contract)', () => {
    it('the runner drains with a real EOS event and a bounded bus wait', () => {
        const drain = pythonFunctionBody('_eos_drain');
        expect(drain).toContain('Gst.Event.new_eos()');
        expect(drain).toContain('timed_pop_filtered');
        // ONE budget for the whole drain, however many attempts it takes: every
        // wait is derived from a deadline set off EOS_DRAIN_TIMEOUT_MS, so the
        // error-path fallback below cannot push the total past it and out of
        // the parent's kill window.
        expect(drain).toContain('deadline = time.monotonic() + EOS_DRAIN_TIMEOUT_MS / 1000.0');
        expect(drain).toContain('deadline - time.monotonic()');
    });

    it('an ERRORED pipeline is drained at the decoder, not reported as drained', () => {
        // A pipeline whose source has already failed can never carry a
        // pipeline-level EOS (GstBaseSrc pushes it from a stopped task), and
        // the ERROR message that ends the bus wait used to be returned as
        // success — so NULL landed MID-DECODE on every bus disconnect, which is
        // how the churn path kept leaving the block wedged. Both routes now
        // hand over to a pad-level EOS into the decoder itself.
        const drain = pythonFunctionBody('_eos_drain');
        expect(drain).toContain('if errored or not pipe.send_event(Gst.Event.new_eos()):');
        expect(drain).toMatch(
            /msg\.type == Gst\.MessageType\.ERROR:\n\s*return _drain_decoder_branch\(deadline\)/,
        );
        // Bounded by the SAME deadline, and reaching the decoder through the
        // pad the keyframe gate already resolved.
        const branch = pythonFunctionBody('_drain_decoder_branch');
        expect(branch).toContain('pad.send_event(Gst.Event.new_eos())');
        expect(branch).toContain('done.wait(max(0.0, deadline - time.monotonic()))');
        // The bus ERROR handler is the one caller that sets the flag.
        expect(runnerSource).toContain('_teardown_pipeline(pipeline, errored=True)');
    });

    it('the drain runs BEFORE the NULL transition, and NULL happens either way', () => {
        const teardown = pythonFunctionBody('_teardown_pipeline');
        const drainAt = teardown.indexOf('_eos_drain(pipe');
        const nullAt = teardown.indexOf('pipe.set_state(Gst.State.NULL)');
        expect(drainAt).toBeGreaterThan(-1);
        expect(nullAt).toBeGreaterThan(-1);
        expect(drainAt).toBeLessThan(nullAt);
        // The NULL is unconditional: a hung driver can't be helped from
        // userspace, and waiting forever would leak runner processes.
        expect(teardown).not.toMatch(/if .*_eos_drain/);
    });

    it('every whole-pipeline teardown goes through the helper', () => {
        // A bare `pipeline.set_state(Gst.State.NULL)` anywhere is a path that
        // skips the drain — the exact shape of the original bug. Per-branch
        // bins (`branch.`/`old.`) are not the decoder and are unaffected.
        expect(runnerSource).not.toMatch(/\bpipeline\.set_state\(Gst\.State\.NULL\)/);
    });

    it('the deliberate stop path (stop cmd, SIGTERM, closed pipe) drains', () => {
        expect(pythonFunctionBody('handle_stop')).toContain('_teardown_pipeline(pipeline)');
        // SIGTERM/SIGINT and a closed command pipe both funnel into handle_stop,
        // so the process-exit paths inherit the drain.
        expect(pythonFunctionBody('on_signal')).toContain('handle_stop');
        expect(pythonFunctionBody('command_reader_thread')).toContain('handle_stop');
        expect(runnerSource).toContain('signal.signal(signal.SIGTERM, on_signal)');
    });

    it('the bus EOS handler skips the drain (the stream already ended)', () => {
        expect(runnerSource).toContain('_teardown_pipeline(pipeline, drain=False)');
    });

    it('the parent kill windows all outlast the drain', () => {
        const drainMs = constantOf(runnerSource, 'EOS_DRAIN_TIMEOUT_MS');
        expect(drainMs).toBeGreaterThan(0);

        // Field-proven floor. EOS has to traverse the whole pipeline and be
        // posted on the bus, and the bootstrap decodebin3 chain holds seconds
        // of data (multiqueue + the ~1s jitter/leaky queues). At the original
        // 1500 ms the cap fired before the bus message arrived, NULL landed
        // mid-decode and STREAMOFF hung forever (Pi 400, syscall capture).
        // Shrinking this back re-arms the hang.
        expect(drainMs).toBeGreaterThanOrEqual(6000);

        // Python's own deadline: drain + the NULL transition must fit.
        expect(FORCE_KILL_TIMEOUT_MS).toBeGreaterThanOrEqual(drainMs + 1000);

        // GstRunner shutdown: SIGKILL no earlier than Python's deadline, and
        // don't hand the runner back to its host (which ends the wait and,
        // under the fork, triggers the emergency SIGKILL) before that. These
        // are derived from FORCE_KILL_TIMEOUT_MS rather than re-typed, so pin
        // the derivation — a literal here would drift.
        expect(gstRunnerSource).toContain('const SHUTDOWN_KILL_MS = FORCE_KILL_TIMEOUT_MS');
        expect(gstRunnerSource).toContain('const SHUTDOWN_EXIT_MS = SHUTDOWN_KILL_MS + 500');
        expect(gstRunnerSource).toContain(
            'const STOP_PIPELINE_EXIT_MS = FORCE_KILL_TIMEOUT_MS + 1000',
        );
        expect(gstRunnerSource).toContain('}, SHUTDOWN_KILL_MS);');
        expect(gstRunnerSource).toContain('this.handback.after(SHUTDOWN_EXIT_MS)');
        expect(gstRunnerSource).toContain('this.handback.after(STOP_PIPELINE_EXIT_MS)');

        // The runner shares the engine process by default (ADR-0012): its only
        // exit is the host seam. A `process.exit` here would take the engine
        // — and every other module's runner — down with one module's teardown.
        const gstRunnerCode = gstRunnerSource
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '');
        expect(gstRunnerCode).not.toMatch(/process\.(exit|send|on)\(/);

        // The host's wait for the runner (in-process) / the shim kill (fork)
        // must outlast the runner's own exit window (SHUTDOWN_EXIT_MS =
        // FORCE_KILL_TIMEOUT_MS + 500), or a draining Python is SIGKILLed
        // — the mid-decode teardown this whole contract exists to prevent.
        const hostCap = constantOf(gstChildProcessSource, 'GST_RUNNER_KILL_TIMEOUT_MS');
        expect(hostCap).toBeGreaterThan(FORCE_KILL_TIMEOUT_MS + 500);
        expect(gstChildProcessSource).toContain('backend.stop(GST_RUNNER_KILL_TIMEOUT_MS)');
    });
});
