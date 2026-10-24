import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REDACTED, type ControlIpcMessage } from '@media-router/shared-types';
import { GstRunner } from './GstRunner.js';
import { PythonProcess } from './PythonProcess.js';

// Test secrets (B-109): unique, so the whole test output can be searched for them.
const RIST = 'zq109-runner-rist-B4m6';
const SRT = 'zq109-runner-srt-pass-C9t3';
// A spawned node runner can take seconds to start on a loaded Pi.
const WAIT = { timeout: 15_000 };
const TEST_MS = 30_000;
const PIPELINES = [
    [
        'a RIST secret',
        RIST,
        `mrristsrc name=ristsrc urls="rist://@0.0.0.0:5004" profile=1 secret="${RIST}" aes-type=128 ! fakesink`,
    ],
    [
        'an SRT passphrase',
        SRT,
        `srtsrc name=src uri="srt://h:4200?mode=caller&passphrase=${SRT}&pbkeylen=16" auto-reconnect=false ! fakesink`,
    ],
];

/** A stand-in for mr-gst-runner: keeps the start command it got, prints the pipeline as a
 *  stand-in rewrite does, reports a warning, a command error and an error quoting it, and exits. */
const FAKE_RUNNER = `
const fs = require('fs');
let buf = '';
process.stdin.on('data', (d) => {
    buf += d;
    if (!buf.includes('\\n')) return;
    const cmd = JSON.parse(buf.slice(0, buf.indexOf('\\n')));
    fs.writeFileSync(process.env.B109_RUNNER_OUT, JSON.stringify(cmd));
    const p = cmd.pipeline;
    process.stderr.write('[mr-gst-runner] native TS module not loaded, parsing with stand-ins: ' + p + '\\n');
    const evs = [
        { event: 'warning', message: 'parser fallback in ' + p },
        { event: 'command_error', message: 'set_property failed in ' + p },
        { event: 'error', message: 'Pipeline parse error: could not link in ' + p, debug: 'description: ' + p },
    ];
    for (const ev of evs) process.stderr.write('GST_JSON:' + JSON.stringify(ev) + '\\n');
    process.exit(0);
});
`;

describe('the runner host logs and forwards no secret (B-109)', () => {
    let dir: string;
    let out: string;
    let lines: string[];
    const savedBinDir = process.env.MR_NATIVE_BIN_DIR;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'b109-runner-'));
        out = join(dir, 'start.json');
        writeFileSync(join(dir, 'fake-runner.cjs'), FAKE_RUNNER);
        const bin = join(dir, 'mr-gst-runner');
        writeFileSync(
            bin,
            `#!/bin/sh\nexec "${process.execPath}" "${join(dir, 'fake-runner.cjs')}"\n`,
        );
        chmodSync(bin, 0o755);
        process.env.MR_NATIVE_BIN_DIR = dir;
        lines = [];
        vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
            lines.push(args.map(String).join(' '));
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        if (savedBinDir === undefined) delete process.env.MR_NATIVE_BIN_DIR;
        else process.env.MR_NATIVE_BIN_DIR = savedBinDir;
        rmSync(dir, { recursive: true, force: true });
    });

    it.each(PIPELINES)(
        'with %s: the start line, its pad-link rules, the runner lines and its event texts carry <redacted>; the runner gets the value',
        async (_kind, secret, pipeline) => {
            const logged = pipeline.replace(secret, REDACTED);
            // A pad-link branch is a launch fragment too: the same pipeline stands in for one.
            const rules = [{ from: 'demux', media: 'video' as const, branches: [pipeline] }];
            const events: Record<string, unknown>[] = [];
            await new Promise<void>((resolve, reject) => {
                const proc = new PythonProcess({
                    pythonRunnerPath: '/nonexistent/gst-pipeline-runner.py',
                    useStdioForData: false,
                    onEvent: (e) => events.push(e),
                    onExit: () => resolve(),
                    onSpawnError: reject,
                });
                proc.start({
                    pipeline,
                    linkOnPadAdded: rules,
                    runner: 'native',
                    env: { B109_RUNNER_OUT: out },
                });
            });
            await vi.waitFor(() => expect(events).toHaveLength(3), WAIT);

            expect(lines.some((l) => l.includes(secret))).toBe(false);
            expect(lines.slice(0, 2)).toEqual([
                `[gst-runner] Starting pipeline (bus-messages, native runner): ${logged}`,
                `[gst-runner] Pad-link rules: ${JSON.stringify([{ ...rules[0], branches: [logged] }])}`,
            ]);
            expect(lines).toContain(
                `[gst-py] [mr-gst-runner] native TS module not loaded, parsing with stand-ins: ${logged}`,
            );
            expect(events).toEqual([
                { event: 'warning', message: `parser fallback in ${logged}` },
                { event: 'command_error', message: `set_property failed in ${logged}` },
                {
                    event: 'error',
                    message: `Pipeline parse error: could not link in ${logged}`,
                    debug: `description: ${logged}`,
                },
            ]);
            const received = JSON.parse(readFileSync(out, 'utf8')) as {
                pipeline: string;
                linkOnPadAdded: { branches: string[] }[];
            };
            expect(received.pipeline === pipeline).toBe(true);
            expect(received.linkOnPadAdded[0].branches[0] === pipeline).toBe(true);
        },
        TEST_MS,
    );

    it(
        'a warning, a command error and an error quoting the launch string are logged, and the error reaches the module, with <redacted>',
        async () => {
            const [, secret, pipeline] = PIPELINES[0];
            const logged = pipeline.replace(secret, REDACTED);
            const sent: ControlIpcMessage[] = [];
            const runner = new GstRunner('/nonexistent/gst-pipeline-runner.py', {
                post: (msg) => sent.push(msg),
                exit: () => {},
            });
            runner.handleControlMessage({
                id: 'start-1',
                type: 'request',
                action: 'startPipeline',
                data: { pipeline, runner: 'native', env: { B109_RUNNER_OUT: out } },
            });
            await vi.waitFor(
                () =>
                    expect(
                        sent.some(
                            (m) =>
                                m.action === 'stateChange' &&
                                (m.data as { state?: string }).state === 'stopped',
                        ),
                    ).toBe(true),
                WAIT,
            );

            const error = sent.find((m) => m.type === 'event' && m.action === 'error');
            expect((error?.data as { message?: string }).message).toBe(
                `Pipeline parse error: could not link in ${logged}`,
            );
            expect(lines).toEqual(
                expect.arrayContaining([
                    `[gst-runner] Warning: parser fallback in ${logged}`,
                    `[gst-runner] Command error: set_property failed in ${logged}`,
                    `[gst-runner] Pipeline ERROR: Pipeline parse error: could not link in ${logged} (description: ${logged})`,
                ]),
            );
            expect(
                JSON.stringify(sent).includes(secret) || lines.some((l) => l.includes(secret)),
            ).toBe(false);
        },
        TEST_MS,
    );
});
