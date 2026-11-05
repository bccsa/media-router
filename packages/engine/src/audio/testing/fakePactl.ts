// A stand-in for pactl, first on PATH (B-200): it answers from files, answers late, hangs as
// pactl does when pipewire-pulse accepts the call and never answers, or fails at once as it does
// when PipeWire is not running (B-207).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** `hang`: no answer, and on SIGTERM an exit 0 with no output, as pactl's own handler does.
 *  `fail`: pactl's own words and exit status when nothing listens on the socket. */
export type FakePactlMode = 'answer' | 'late' | 'hang' | 'fail';

// The mode is read before the call is logged: a test that sees the call knows its mode.
const SCRIPT = `#!/bin/sh
d=$(dirname "$0")
m=$(cat "$d/mode")
echo "$*" >> "$d/calls"
case $m in
hang)
    trap 'exit 0' TERM
    sleep 3 &
    wait $!
    exit 0 ;;
late) sleep "$(cat "$d/lateS")" ;;
fail)
    echo 'Connection failure: Connection refused' >&2
    exit 1 ;;
esac
case "$1 $2" in
'list sources') cat "$d/sources" ;;
'list sinks') cat "$d/sinks" ;;
'info ') cat "$d/info" ;;
esac
`;

export interface FakePactl {
    mode(mode: FakePactlMode, lateS?: number): void;
    sources(text: string): void;
    sinks(text: string): void;
    /** Each call's arguments, in the order they came. */
    calls(): string[];
    /** PATH as it was, the directory removed. */
    remove(): void;
}

/** Puts the stand-in first on this process's PATH; null when this tmp dir cannot run it. */
export function installFakePactl(): FakePactl | null {
    const dir = mkdtempSync(join(tmpdir(), 'mr-b200-'));
    const bin = join(dir, 'pactl');
    writeFileSync(bin, SCRIPT, { mode: 0o755 });
    const put = (name: string, text: string) => writeFileSync(join(dir, name), text);
    put('mode', 'answer');
    put('lateS', '0.3');
    put('sources', '');
    put('sinks', '');
    put('info', 'Server Name: PulseAudio (on PipeWire 1.2.7)\nCookie: f196:62ca\n');
    if (!spawnSync(bin, ['info'], { encoding: 'utf8' }).stdout?.includes('Cookie:')) {
        rmSync(dir, { recursive: true, force: true });
        console.warn(`[B-200] the stand-in pactl cannot run from ${tmpdir()}: its tests skipped`);
        return null;
    }
    put('calls', '');
    const path = process.env.PATH;
    process.env.PATH = `${dir}:${path ?? ''}`;
    return {
        mode: (mode, lateS = 0.3) => {
            put('lateS', String(lateS));
            put('mode', mode);
        },
        sources: (text) => put('sources', text),
        sinks: (text) => put('sinks', text),
        calls: () => readFileSync(join(dir, 'calls'), 'utf8').split('\n').filter(Boolean),
        remove: () => {
            process.env.PATH = path;
            rmSync(dir, { recursive: true, force: true });
        },
    };
}
