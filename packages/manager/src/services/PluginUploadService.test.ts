import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PluginUploadService } from './PluginUploadService.js';

describe('PluginUploadService', () => {
    let tmp: string;
    let registry: { find: (id: string) => unknown };

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-uploads-'));
        registry = {
            find: (id: string) =>
                id === 'video-player' || id === 'logo-plugin' ? { pluginId: id } : undefined,
        };
    });

    afterEach(() => {
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    function makeService() {
        return new PluginUploadService(registry as never, { root: tmp });
    }

    it('writes <root>/<pluginId>/<moduleId>.<ext> and returns the absolute path', () => {
        const svc = makeService();
        const res = svc.save({
            pluginId: 'video-player',
            moduleId: 'video-player-1',
            filename: 'standby.png',
            bytes: Buffer.from('fake-png'),
        });
        const expected = path.join(tmp, 'video-player', 'video-player-1.png');
        expect(res.path).toBe(expected);
        expect(res.filename).toBe('video-player-1.png');
        expect(fs.readFileSync(expected, 'utf-8')).toBe('fake-png');
    });

    it('re-uploading the same module with a different extension overwrites — no orphans accumulate', () => {
        // Operator switches from PNG to JPG: the prior file must be removed
        // so the next pipeline build doesn't see a stale path the config no
        // longer references.
        const svc = makeService();
        svc.save({
            pluginId: 'video-player',
            moduleId: 'video-player-1',
            filename: 'first.png',
            bytes: Buffer.from('png'),
        });
        svc.save({
            pluginId: 'video-player',
            moduleId: 'video-player-1',
            filename: 'second.jpg',
            bytes: Buffer.from('jpg'),
        });
        const dir = path.join(tmp, 'video-player');
        expect(fs.readdirSync(dir).sort()).toEqual(['video-player-1.jpg']);
    });

    it('rejects an unknown pluginId so unknown widgets can not scribble into the uploads root', () => {
        const svc = makeService();
        expect(() =>
            svc.save({
                pluginId: 'rogue-plugin',
                moduleId: 'mod',
                filename: 'evil.png',
                bytes: Buffer.from('x'),
            }),
        ).toThrow(/unknown plugin/);
    });

    it('rejects unsafe pluginId / moduleId values that would escape the storage root', () => {
        const svc = makeService();
        expect(() =>
            svc.save({
                pluginId: '../etc',
                moduleId: 'mod',
                filename: 'foo.png',
                bytes: Buffer.from('x'),
            }),
        ).toThrow(/unsafe pluginId/);
        expect(() =>
            svc.save({
                pluginId: 'video-player',
                moduleId: '../sneaky',
                filename: 'foo.png',
                bytes: Buffer.from('x'),
            }),
        ).toThrow(/unsafe moduleId/);
    });

    it('rejects empty body and extensions outside the whitelist', () => {
        const svc = makeService();
        expect(() =>
            svc.save({
                pluginId: 'video-player',
                moduleId: 'mod',
                filename: 'x.png',
                bytes: Buffer.alloc(0),
            }),
        ).toThrow(/empty body/);
        expect(() =>
            svc.save({
                pluginId: 'video-player',
                moduleId: 'mod',
                filename: 'x.exe',
                bytes: Buffer.from('x'),
            }),
        ).toThrow(/unsupported extension/);
    });

    it('read() returns the file bytes + content type for previews', () => {
        // UI preview path: socket round-trips the bytes (no HTTP endpoint),
        // so the service has to surface the content type for `data:` URLs.
        const svc = makeService();
        svc.save({
            pluginId: 'video-player',
            moduleId: 'm1',
            filename: 'standby.jpg',
            bytes: Buffer.from('jpeg-bytes'),
        });
        const fetched = svc.read('video-player', 'm1.jpg');
        expect(fetched.bytes.toString('utf-8')).toBe('jpeg-bytes');
        expect(fetched.contentType).toBe('image/jpeg');
    });

    it('read() rejects path-traversal attempts in the filename', () => {
        // The RPC handler passes the filename through unchanged; the service
        // is the trust boundary for filesystem access.
        const svc = makeService();
        expect(() => svc.read('video-player', '../etc/passwd')).toThrow(/unsafe filename/);
        expect(() => svc.read('video-player', 'subdir/foo.png')).toThrow(/unsafe filename/);
    });

    it('isolates each plugin under its own subdirectory', () => {
        // Plugins should never see each other's uploads — the per-plugin
        // subdir is what makes the dedup-by-module walk safe to do across
        // multiple plugins in the same uploads root.
        const svc = makeService();
        svc.save({
            pluginId: 'video-player',
            moduleId: 'm1',
            filename: 'a.png',
            bytes: Buffer.from('a'),
        });
        svc.save({
            pluginId: 'logo-plugin',
            moduleId: 'm1',
            filename: 'b.png',
            bytes: Buffer.from('b'),
        });
        expect(fs.readdirSync(path.join(tmp, 'video-player'))).toEqual(['m1.png']);
        expect(fs.readdirSync(path.join(tmp, 'logo-plugin'))).toEqual(['m1.png']);
    });
});
