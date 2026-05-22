import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listDrmConnectors, pickActiveDisplay, resolveConnectorId } from './drmConnectors.js';

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

describe('pickActiveDisplay', () => {
    let tmp: string;

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drm-pick-'));
    });

    afterEach(() => {
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    function fixture(name: string, status: string, connectorId?: number) {
        const dir = path.join(tmp, name);
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, 'status'), `${status}\n`);
        if (connectorId !== undefined) {
            fs.writeFileSync(path.join(dir, 'connector_id'), `${connectorId}\n`);
        }
    }

    it('returns an empty choice when no display is preferred (auto-pick behaviour)', () => {
        fixture('card0-HDMI-A-1', 'connected', 32);
        expect(pickActiveDisplay('', tmp)).toEqual({
            name: '',
            connectorId: undefined,
            substituted: false,
        });
    });

    it('returns the requested display unchanged when it is connected', () => {
        fixture('card0-HDMI-A-1', 'connected', 32);
        fixture('card0-HDMI-A-2', 'connected', 42);
        expect(pickActiveDisplay('HDMI-A-1', tmp)).toEqual({
            name: 'HDMI-A-1',
            connectorId: 32,
            substituted: false,
        });
    });

    it('substitutes the first connected connector when the requested one is disconnected', () => {
        fixture('card0-HDMI-A-1', 'disconnected', 32);
        fixture('card0-HDMI-A-2', 'connected', 42);
        // This is the case the user hit: their picked display was unplugged
        // so the live pipeline should land on the other (connected) output
        // instead of crash-looping on the dark one.
        expect(pickActiveDisplay('HDMI-A-1', tmp)).toEqual({
            name: 'HDMI-A-2',
            connectorId: 42,
            substituted: true,
        });
    });

    it('substitutes when the requested connector is missing from sysfs entirely', () => {
        fixture('card0-HDMI-A-2', 'connected', 42);
        expect(pickActiveDisplay('DP-99', tmp)).toEqual({
            name: 'HDMI-A-2',
            connectorId: 42,
            substituted: true,
        });
    });

    it('returns the requested display as-is when nothing is connected', () => {
        // Don't substitute "no display at all" for a specific request — the
        // caller can warn separately. Keeps the pipeline targeting whatever
        // the user picked so it lights up the moment something is plugged in.
        fixture('card0-HDMI-A-1', 'disconnected', 32);
        fixture('card0-HDMI-A-2', 'disconnected', 42);
        expect(pickActiveDisplay('HDMI-A-1', tmp)).toEqual({
            name: 'HDMI-A-1',
            connectorId: 32,
            substituted: false,
        });
    });

    it('returns the requested name with undefined connectorId when sysfs is empty and the request is unknown', () => {
        expect(pickActiveDisplay('HDMI-A-1', tmp)).toEqual({
            name: 'HDMI-A-1',
            connectorId: undefined,
            substituted: false,
        });
    });

    it('returns the requested name with no id when sysfs is missing entirely', () => {
        expect(pickActiveDisplay('HDMI-A-1', '/nonexistent-path-xyz')).toEqual({
            name: 'HDMI-A-1',
            connectorId: undefined,
            substituted: false,
        });
    });

    it('skips Writeback connectors when picking a substitute', () => {
        // Hit on 10.9.1.166: Writeback-1/2 show as `connected` in sysfs
        // alongside an unplugged HDMI-A-*. Without this filter the surface
        // would land on the virtual writeback sink — invisible to the
        // operator and looks identical to "video player won't start".
        fixture('card0-HDMI-A-1', 'disconnected', 32);
        fixture('card0-Writeback-1', 'connected', 50);
        fixture('card0-DSI-2', 'connected', 60);
        expect(pickActiveDisplay('HDMI-A-1', tmp)).toEqual({
            name: 'DSI-2',
            connectorId: 60,
            substituted: true,
        });
    });

    it('returns the requested Writeback connector if the user explicitly picked one and it is connected', () => {
        // Filter applies only to *substitution* candidates. If the operator
        // explicitly selected a Writeback in the GUI we honour it.
        fixture('card0-Writeback-1', 'connected', 50);
        expect(pickActiveDisplay('Writeback-1', tmp)).toEqual({
            name: 'Writeback-1',
            connectorId: 50,
            substituted: false,
        });
    });

    it('falls back to the preferred name (no substitution) when only Writeback connectors are connected', () => {
        // No real display lit, only the writeback sink → don't substitute,
        // keep targeting the user's pick so the moment a real cable is
        // plugged in we'll start rendering there.
        fixture('card0-HDMI-A-1', 'disconnected', 32);
        fixture('card0-Writeback-1', 'connected', 50);
        expect(pickActiveDisplay('HDMI-A-1', tmp)).toEqual({
            name: 'HDMI-A-1',
            connectorId: 32,
            substituted: false,
        });
    });
});
