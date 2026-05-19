import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listDrmConnectors, resolveConnectorId } from './drmConnectors.js';

describe('listDrmConnectors', () => {
    let tmp: string;

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drm-test-'));
    });

    afterEach(() => {
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    function fixture(name: string, status: string, connectorId?: number) {
        const dir = path.join(tmp, name);
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, 'status'), status);
        if (connectorId !== undefined) {
            fs.writeFileSync(path.join(dir, 'connector_id'), `${connectorId}\n`);
        }
    }

    it('returns [] for a missing directory', () => {
        expect(listDrmConnectors('/nonexistent-path-xyz')).toEqual([]);
    });

    it('reads connector names and status, ignores the raw `cardN` entry', () => {
        fs.mkdirSync(path.join(tmp, 'card0')); // raw card dir — must be skipped
        fixture('card0-HDMI-A-1', 'connected\n', 32);
        fixture('card0-HDMI-A-2', 'disconnected\n', 42);
        const connectors = listDrmConnectors(tmp);
        expect(connectors).toHaveLength(2);
        const hdmi1 = connectors.find((c) => c.name === 'HDMI-A-1')!;
        expect(hdmi1.label).toBe('HDMI-A-1 (connected)');
        expect(hdmi1.meta?.status).toBe('connected');
        expect(hdmi1.meta?.connectorId).toBe(32);
        const hdmi2 = connectors.find((c) => c.name === 'HDMI-A-2')!;
        expect(hdmi2.meta?.status).toBe('disconnected');
        expect(hdmi2.meta?.connectorId).toBe(42);
    });

    it('tolerates missing status file with status=unknown', () => {
        fs.mkdirSync(path.join(tmp, 'card0-DP-1'));
        const connectors = listDrmConnectors(tmp);
        expect(connectors).toEqual([
            expect.objectContaining({
                name: 'DP-1',
                meta: expect.objectContaining({ status: 'unknown' }),
            }),
        ]);
    });

    it('leaves connectorId undefined when the kernel does not expose connector_id', () => {
        fixture('card0-DP-1', 'connected\n'); // no connector_id file written
        const [c] = listDrmConnectors(tmp);
        expect(c.meta?.connectorId).toBeUndefined();
    });
});

describe('resolveConnectorId', () => {
    let tmp: string;

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drm-resolve-'));
    });

    afterEach(() => {
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    function fixture(name: string, connectorId?: number) {
        const dir = path.join(tmp, name);
        fs.mkdirSync(dir);
        if (connectorId !== undefined) {
            fs.writeFileSync(path.join(dir, 'connector_id'), `${connectorId}\n`);
        }
    }

    it('returns the numeric id when the connector exists', () => {
        fixture('card2-HDMI-A-1', 32);
        fixture('card2-HDMI-A-2', 42);
        expect(resolveConnectorId('HDMI-A-1', tmp)).toBe(32);
        expect(resolveConnectorId('HDMI-A-2', tmp)).toBe(42);
    });

    it('returns undefined for a missing connector', () => {
        fixture('card2-HDMI-A-1', 32);
        expect(resolveConnectorId('DP-99', tmp)).toBeUndefined();
    });

    it('returns undefined when the connector_id file is missing', () => {
        fixture('card2-HDMI-A-1'); // no id file
        expect(resolveConnectorId('HDMI-A-1', tmp)).toBeUndefined();
    });

    it('returns undefined for an empty name', () => {
        expect(resolveConnectorId('', tmp)).toBeUndefined();
    });

    it('returns undefined for a missing dir', () => {
        expect(resolveConnectorId('HDMI-A-1', '/nonexistent-path-xyz')).toBeUndefined();
    });
});
