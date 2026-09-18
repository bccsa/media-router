import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RunnerStartOptions } from './PythonProcess.js';
import { installedRoot, pluginsRoot } from './nativeBinaries.js';

/**
 * Which runner hosts a pipeline (ADR-0019): the python `gst-pipeline-runner.py`
 * or the native `mr-gst-runner` binary. The two speak the same protocol; the
 * native one implements the subset of the start payload every audio-matrix
 * and wire-facing module uses and costs the GStreamer graph alone instead of
 * ~19 MB of interpreter + PyGObject per module (10.9.16.50, 2026-09-16).
 *
 * Selection is per pipeline, from three inputs, in this order:
 *  1. `PipelineDescription.runner` — `'python'` pins python (a module that
 *     knows it needs a python-only feature at runtime); `'native'` asks for
 *     the native runner.
 *  2. `MR_GST_RUNNER_NATIVE=0` — the engine-wide rollback: every description
 *     goes python unless it pins `runner: 'native'`. Native is the DEFAULT
 *     (since the 2026-09-18 soak); nothing has to be set to get it.
 *  3. Eligibility — the description must stay inside what the binary
 *     implements (`nativeRunnerEligible`), and the binary must exist. Anything
 *     else falls back to python; a request that cannot be honoured is logged,
 *     never silently downgraded.
 */
export type RunnerKind = 'python' | 'native';

/** The `spawn` target for a runner: the executable and its arguments. */
export interface RunnerCommand {
    kind: RunnerKind;
    file: string;
    args: string[];
}

/** Payload fields the native runner refuses (it mirrors `unsupported_field` in runner.cpp). */
const NATIVE_UNSUPPORTED_OBJECTS = ['rist', 'preserveSourceTimeline'] as const;

function dirNames(root: string): string[] {
    try {
        return readdirSync(root, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name);
    } catch {
        return [];
    }
}

const defaultLog = (line: string): void => console.error(`[gst-runner] ${line}`);

/**
 * The native form of runner hook `module` (ADR-0020): `libmrhook_<module>.so`
 * in some plugin's `native/<tool>/` dir (the repo/deployed tree) or its
 * libexec install. Null when the hook exists only as python — the module then
 * stays on the python runner. Same roots as `nativeBinaries.ts` and the same
 * rule: one match per owning plugin (the deployed tree preferred over the
 * install), and two plugins shipping the same hook name is a packaging fault
 * that fails loud (logged, null) — never first-in-directory-order wins.
 */
export function resolveNativeHook(
    module: string,
    env: NodeJS.ProcessEnv = process.env,
    log: (line: string) => void = defaultLog,
): string | null {
    if (!module || module.includes('/')) return null;
    const file = `libmrhook_${module}.so`;
    const matches = new Map<string, string>();
    const plugins = env.MR_PLUGINS_DIR ?? pluginsRoot();
    for (const plugin of dirNames(plugins)) {
        for (const tool of dirNames(join(plugins, plugin, 'native'))) {
            const p = join(plugins, plugin, 'native', tool, file);
            if (existsSync(p)) {
                matches.set(plugin, p);
                break;
            }
        }
    }
    const libexec = env.MR_LIBEXEC_DIR ?? installedRoot();
    for (const plugin of dirNames(libexec)) {
        const p = join(libexec, plugin, file);
        if (!matches.has(plugin) && existsSync(p)) matches.set(plugin, p);
    }
    if (matches.size > 1) {
        log(`runner hook '${module}' is ambiguous — ${[...matches.keys()].join(', ')} all ship ${file}; python runner`);
        return null;
    }
    return matches.values().next().value ?? null;
}

/**
 * Why a description cannot run natively, or null when it can. Exported so a
 * module (and the tests) can ask before pinning `runner: 'native'`.
 */
export function nativeRunnerIneligibility(
    opts: RunnerStartOptions,
    env: NodeJS.ProcessEnv = process.env,
    log: (line: string) => void = defaultLog,
): string | null {
    const o = opts as unknown as Record<string, unknown>;
    for (const key of NATIVE_UNSUPPORTED_OBJECTS) {
        if (o[key] !== undefined && o[key] !== null) return key;
    }
    const hooks = o.runnerHooks;
    if (Array.isArray(hooks)) {
        // Every hook the pipeline names must exist in its native form.
        for (const hook of hooks as Array<{ module?: unknown }>) {
            const module = typeof hook?.module === 'string' ? hook.module : '';
            if (module && !resolveNativeHook(module, env, log)) return `runnerHooks: ${module}`;
        }
    }
    if (opts.readKlvNames) return 'readKlvNames';
    if (opts.useStdioForData) return 'useStdioForData';
    if (!opts.timeSyncContract && opts.clock) return 'clock';
    return null;
}

export function nativeRunnerEligible(opts: RunnerStartOptions, env: NodeJS.ProcessEnv = process.env): boolean {
    return nativeRunnerIneligibility(opts, env) === null;
}

/**
 * Where the native runner binary is: `MR_NATIVE_BIN_DIR` (authoritative, as
 * for every native binary) → the repo/deployed tree
 * (`packages/engine/native/mr-gst-runner/`) → the packaged install
 * (`/usr/libexec/media-router/engine/`). Null when none exists.
 */
export function resolveNativeRunner(env: NodeJS.ProcessEnv = process.env): string | null {
    const name = 'mr-gst-runner';
    if (env.MR_NATIVE_BIN_DIR) {
        const p = join(env.MR_NATIVE_BIN_DIR, name);
        return existsSync(p) ? p : null;
    }
    const candidates = [
        // src/child-process or dist/child-process -> packages/engine/native/mr-gst-runner
        join(__dirname, '..', '..', 'native', name, name),
        join(installedRoot(), 'engine', name),
    ];
    return candidates.find((p) => existsSync(p)) ?? null;
}

/** Native by default; `MR_GST_RUNNER_NATIVE=0` is the engine-wide rollback to python. */
export function nativeRunnerDefault(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.MR_GST_RUNNER_NATIVE !== '0';
}

/**
 * Pick the runner for one start. `log` receives one line when a native
 * request had to fall back (so it is visible, never silent).
 */
export function selectRunner(
    opts: RunnerStartOptions,
    pythonRunnerPath: string,
    env: NodeJS.ProcessEnv = process.env,
    log: (line: string) => void = defaultLog,
): RunnerCommand {
    const python: RunnerCommand = { kind: 'python', file: 'python3', args: [pythonRunnerPath] };
    const requested = opts.runner;
    if (requested === 'python') return python;
    if (requested !== 'native' && !nativeRunnerDefault(env)) return python;

    const why = nativeRunnerIneligibility(opts, env, log);
    if (why) {
        if (requested === 'native') log(`native runner requested but the description uses \`${why}\` — python runner`);
        return python;
    }
    const file = resolveNativeRunner(env);
    if (!file) {
        log(
            requested === 'native'
                ? 'native runner requested but mr-gst-runner is not built/installed — python runner'
                : 'mr-gst-runner is not built/installed (make native) — python runner',
        );
        return python;
    }
    return { kind: 'native', file, args: [] };
}
