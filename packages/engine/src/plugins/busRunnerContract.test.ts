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

    it('the gst runner handles the bus_reinput wire command (live input swap)', () => {
        expect(runnerSource).toContain('"bus_reinput"');
        expect(runnerSource).toContain('def handle_bus_reinput');
        // The tracked-RPC response event GstRunner resolves on.
        expect(runnerSource).toContain('"event": "bus_reinput_done"');
    });

    it('the runner names the source element on every bus error', () => {
        // `element` is the gst bus message's own src name. The video-player's
        // decoder ladder demotes ONLY on errors attributable to the active
        // decoder element, so dropping this field would make every real decoder
        // failure look unattributable and the whole demotion ladder would go
        // dark (see helpers/decoderRuntime.ts → classifyDecoderFailure).
        expect(runnerSource).toContain(
            'element = (src.get_name() or "") if src is not None else ""',
        );
        expect(runnerSource).toContain('"element": element');
    });

    it('the PLAYING watchdog keeps tagging its error `playing_timeout`', () => {
        // Synthesised, not posted by the bus — it names no element. The
        // video-player lists this exact string in SYNTHESISED_ERROR_KINDS so a
        // wedged compositor (never reaches PLAYING → watchdog every 10 s) can't
        // demote a healthy hardware decoder even if the runner ever started
        // forwarding a last-seen element name on it.
        expect(runnerSource).toContain('"kind": "playing_timeout"');
    });

    it('the runner detects source timeline discontinuities post-latch', () => {
        // The watch emits a `timeline_discont`-tagged pipeline error so the
        // normal restartOnError path re-latches; modular delta math keeps the
        // legal 33-bit wrap invisible (2026-07-23 wrap drill).
        expect(runnerSource).toContain('"kind": "timeline_discont"');
    });

    it('the runner implements the preserveSourceTimeline start option', () => {
        // GstChildProcess sends `preserveSourceTimeline: { demux }` in the
        // start payload (PipelineDescription contract); the runner must read
        // that exact key and define the installer, or the feature is silently
        // lost (the decoderThreadType trap).
        expect(runnerSource).toContain('data.get("preserveSourceTimeline")');
        expect(runnerSource).toContain('def _install_preserve_timeline');
    });

    it('the runner implements the keyframeGate start option', () => {
        // video-player sends `keyframeGate: { decoder }` on every EXPLICIT
        // decoder rung (PipelineDescription contract → GstChildProcess
        // startPayload → runner). The runner must read that exact key and
        // define the installer: silently losing it (the decoderThreadType
        // trap) puts the stateless V4L2 decoders straight back on mid-GOP
        // stream entry, whose failure mode is a kernel D-state hang that
        // takes V4L2 down box-wide until reboot.
        expect(runnerSource).toContain('data.get("keyframeGate")');
        expect(runnerSource).toContain('def _start_keyframe_gate');
        // The gate IS the DELTA_UNIT test — it drops until the first buffer
        // without the flag, then removes itself.
        expect(runnerSource).toContain('Gst.BufferFlags.DELTA_UNIT');
        expect(runnerSource).toContain('Gst.PadProbeReturn.DROP');
    });

    it('a keyframeGate naming an element the pipeline lacks is a HARD error', () => {
        // Same rule as tsProbe/renderWatch: a module that explicitly asked for
        // the gate must not silently run ungated because the element name
        // drifted. The runner tears the pipeline down instead.
        expect(runnerSource).toContain('"keyframeGate: decoder not found:');
    });

    it('the non-gst fan-out sidecar speaks the same wire commands', () => {
        const sidecarSource = readFileSync(
            join(__dirname, '../../../../plugins/unixfdbus-core/py/unixfd-fanout.py'),
            'utf8',
        );
        expect(sidecarSource).toContain("'bus_attach'");
        expect(sidecarSource).toContain("'bus_detach'");
    });
});
