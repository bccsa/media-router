import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveNativeBinary, resolvePythonScript, pluginPythonPaths } from './nativeBinaries.js';

/** Fake plugins tree: <root>/<plugin>/native/<tool>/<tool> + <plugin>/py/<script>. */
function addTool(root: string, plugin: string, tool: string): string {
    const dir = join(root, plugin, 'native', tool);
    mkdirSync(dir, { recursive: true });
    const bin = join(dir, tool);
    writeFileSync(bin, '#!/bin/sh\n');
    return bin;
}

function addScript(root: string, plugin: string, script: string): string {
    const dir = join(root, plugin, 'py');
    mkdirSync(dir, { recursive: true });
    const p = join(dir, script);
    writeFileSync(p, '# test\n');
    return p;
}

describe('nativeBinaries resolution', () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'mr-native-'));
        process.env.MR_PLUGINS_DIR = root;
        // Sandbox the packaged-install root too — the host machine may have a
        // real /usr/libexec/media-router that would leak into scan results.
        process.env.MR_LIBEXEC_DIR = join(root, 'libexec');
        delete process.env.MR_NATIVE_BIN_DIR;
    });

    afterEach(() => {
        delete process.env.MR_PLUGINS_DIR;
        delete process.env.MR_LIBEXEC_DIR;
        delete process.env.MR_NATIVE_BIN_DIR;
        rmSync(root, { recursive: true, force: true });
    });

    it('MR_NATIVE_BIN_DIR is authoritative — no fallback when the binary is absent there', () => {
        addTool(root, 'unixfdbus-core', 'mr-bus-fanout');
        process.env.MR_NATIVE_BIN_DIR = join(root, 'empty-override');
        expect(resolveNativeBinary('mr-bus-fanout')).toBeNull();
    });

    it('finds a tool in a library plugin via the cross-plugin scan', () => {
        const bin = addTool(root, 'unixfdbus-core', 'mr-bus-fanout');
        expect(resolveNativeBinary('mr-bus-fanout')).toBe(bin);
    });

    it('own plugin wins when two plugins ship the same tool name', () => {
        const mine = addTool(root, 'my-plugin', 'probe');
        addTool(root, 'other-plugin', 'probe');
        expect(resolveNativeBinary('probe', 'my-plugin')).toBe(mine);
    });

    it('ambiguous cross-plugin scan fails loud (null), even with legacy fallbacks present', () => {
        addTool(root, 'a-plugin', 'probe');
        addTool(root, 'b-plugin', 'probe');
        expect(resolveNativeBinary('probe')).toBeNull();
    });

    it('returns null for unknown tools', () => {
        expect(resolveNativeBinary('does-not-exist')).toBeNull();
    });

    it('resolvePythonScript: own plugin first, then unambiguous scan', () => {
        const shared = addScript(root, 'mpegts-core', 'helper.py');
        expect(resolvePythonScript('helper.py')).toBe(shared);
        expect(resolvePythonScript('helper.py', 'ts-splitter')).toBe(shared);
        const own = addScript(root, 'ts-splitter', 'helper.py');
        expect(resolvePythonScript('helper.py', 'ts-splitter')).toBe(own);
        // Without a pluginId the duplicated name is ambiguous now
        expect(resolvePythonScript('helper.py')).toBeNull();
    });

    it('pluginPythonPaths lists existing py dirs, sorted by plugin name', () => {
        addScript(root, 'rist-core', 'librist.py');
        addScript(root, 'unixfdbus-core', 'unixfd-fanout.py');
        mkdirSync(join(root, 'no-py-plugin'), { recursive: true });
        expect(pluginPythonPaths()).toEqual([
            join(root, 'rist-core', 'py'),
            join(root, 'unixfdbus-core', 'py'),
        ]);
    });
});
