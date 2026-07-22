import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUS_WATCHDOG_PREFIX, buildBusSrc, busTeeName } from './busHelpers.js';

/**
 * Cross-language contract pins between the TS bus helpers and the python
 * gst runner. These literals live on both sides of a process boundary — a
 * rename on one side silently breaks stall tagging / fan-out addressing on
 * the other, so pin them here.
 */
const runnerSource = readFileSync(
    join(__dirname, '..', 'child-process', 'gst-pipeline-runner.py'),
    'utf8',
);

describe('bus helpers ↔ gst-pipeline-runner contracts', () => {
    it('the runner tags watchdog errors by the exact BUS_WATCHDOG_PREFIX', () => {
        // on_bus_message: element.startswith("buswd") → kind: 'bus_stall'.
        expect(runnerSource).toContain(`element.startswith("${BUS_WATCHDOG_PREFIX}")`);
        expect(runnerSource).toContain('"kind": "bus_stall"');
    });

    it('buildBusSrc watchdog names match what the runner tags', () => {
        const fragment = buildBusSrc({ port: 41000, name: 'busin_x', stallTimeoutMs: 5000 });
        const name = /watchdog name=(\S+)/.exec(fragment)?.[1] ?? '';
        expect(name.startsWith(BUS_WATCHDOG_PREFIX)).toBe(true);
    });

    it('the runner group-bind workaround for the removed UDP bus is gone', () => {
        expect(runnerSource).not.toContain('_isolate_loopback_bus_udpsrc');
    });

    it('fan-out tee names are addressable from the port alone (bus_attach contract)', () => {
        // BusFanoutCoordinator sends busTeeName(port); the runner resolves the
        // tee by that name. The tee must appear verbatim in the producer
        // fragment so gst names it identically.
        expect(busTeeName(41000)).toBe('busout_41000');
    });

    it('the gst runner handles the bus_attach/bus_detach wire commands', () => {
        // UnixFdFanoutController and BusFanoutCoordinator address producers
        // with these exact command names over stdio.
        expect(runnerSource).toContain('"bus_attach"');
        expect(runnerSource).toContain('"bus_detach"');
    });

    it('the non-gst fan-out sidecar speaks the same wire commands', () => {
        const sidecarSource = readFileSync(
            join(__dirname, '..', 'child-process', 'unixfd-fanout.py'),
            'utf8',
        );
        expect(sidecarSource).toContain("'bus_attach'");
        expect(sidecarSource).toContain("'bus_detach'");
    });
});
