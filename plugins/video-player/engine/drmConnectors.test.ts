import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listDrmConnectors } from './drmConnectors.js';

describe('listDrmConnectors', () => {
    let tmp: string;

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drm-test-'));
    });

    afterEach(() => {
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    function fixture(name: string, status: string) {
        const dir = path.join(tmp, name);
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, 'status'), status);
    }

    it('returns [] for a missing directory', () => {
        expect(listDrmConnectors('/nonexistent-path-xyz')).toEqual([]);
    });

    it('reads connector names and status, ignores the raw `cardN` entry', () => {
        fs.mkdirSync(path.join(tmp, 'card0')); // raw card dir — must be skipped
        fixture('card0-HDMI-A-1', 'connected\n');
        fixture('card0-HDMI-A-2', 'disconnected\n');
        const connectors = listDrmConnectors(tmp);
        expect(connectors).toHaveLength(2);
        const hdmi1 = connectors.find((c) => c.name === 'HDMI-A-1')!;
        expect(hdmi1.label).toBe('HDMI-A-1 (connected)');
        expect(hdmi1.meta?.status).toBe('connected');
        const hdmi2 = connectors.find((c) => c.name === 'HDMI-A-2')!;
        expect(hdmi2.meta?.status).toBe('disconnected');
    });

    it('tolerates missing status file with status=unknown', () => {
        fs.mkdirSync(path.join(tmp, 'card0-DP-1'));
        const connectors = listDrmConnectors(tmp);
        expect(connectors).toEqual([
            expect.objectContaining({ name: 'DP-1', meta: expect.objectContaining({ status: 'unknown' }) }),
        ]);
    });
});
