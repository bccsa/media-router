import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUS_WATCHDOG_PREFIX, buildBusSink, buildBusSrc, busTeeName } from './busHelpers.js';

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
/**
 * The egress-stamper subsystem the runner imports (`gst_bus_stamper.py` and the
 * three modules it is split across — lazy arm and lifecycle, the python probe,
 * the native splice, the engine events). Same process, same contracts; they are
 * separate files only because the runner has no business being 3600 lines.
 *
 * Read as one string: every claim below is about the SUBSYSTEM, so which of its
 * files satisfies a given one is an internal detail that may move. What must
 * not move is the module the runner imports — `gst_bus_stamper` — and the
 * counted claims (one builder per event) hold across the whole set.
 */
const STAMPER_FILES = [
    'gst_bus_stamper.py',
    'gst_stamp_probe.py',
    'gst_stamp_native.py',
    'gst_stamp_events.py',
];
const stamperSource = STAMPER_FILES.map((f) =>
    readFileSync(join(__dirname, '..', 'child-process', f), 'utf8'),
).join('\n');
/** Claims that may be satisfied by either half of the runner process. */
const runnerProcess = runnerSource + stamperSource;

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

    it('the runner implements the timeSyncContract start option', () => {
        // GstPluginBase stamps `timeSyncContract: true` on a clockSync
        // description when the engine runs the contract (PipelineDescription →
        // GstChildProcess startPayload → runner). The runner must read that
        // exact key and define the installer, or the contract is silently lost
        // (the decoderThreadType trap) and pipelines drift as before.
        expect(runnerSource).toContain('data.get("timeSyncContract")');
        expect(runnerSource).toContain('def _apply_contract_clock');
        // The three moves that make running-time ≡ house-clock time (ADR-0005):
        // a fixed monotonic system clock and a pinned timeline.
        expect(runnerSource).toContain('Gst.ClockType.MONOTONIC');
        expect(runnerSource).toContain('pipe.set_start_time(Gst.CLOCK_TIME_NONE)');
        expect(runnerSource).toContain('pipe.set_base_time(0)');
    });

    it('the contract and the legacy net clock are mutually exclusive', () => {
        // Contract mode must never reach the clock authority: an else-branch,
        // not two independent ifs. `_apply_net_clock` is the only path that can
        // block a start (2 s wait_for_sync) and the only one that relaxes the
        // sink to sync=false — neither belongs on the contract path.
        expect(runnerSource).toContain('        _apply_contract_clock(pipeline)\n    else:\n');
        expect(runnerSource).toContain('_apply_net_clock(pipeline, data.get("clock"))');
    });

    it('the egress stamper arms the tee that bus_attach names (busTeeName contract)', () => {
        // The stamper used to walk the element tree for a `busout_` prefix it
        // held privately, so a rename on the TS side would have left every
        // producer unstamped with nothing to notice it — the pipeline still
        // runs, the wire still flows, and every consumer quietly falls back to
        // arrival timing (ADR-0005's whole failure mode). It now arms the tee
        // `bus_attach` names, which is the same string BusFanoutCoordinator
        // addresses the fan-out branch with: one name, one failure mode.
        expect(busTeeName(41000)).toBe('busout_41000');
        expect(runnerSource).toContain('tee_name = data.get("tee", "")');
        expect(runnerSource).toContain('tee = pipeline.get_by_name(tee_name)');
        expect(runnerSource).toContain('gst_bus_stamper.arm(tee, tee_name)');
        expect(runnerProcess).not.toContain('_BUS_TEE_PREFIX');
    });

    it('the stamper is enabled by the same flag as the contract clock, before PLAYING', () => {
        // The stamp only means house-clock media time if base_time is pinned to
        // 0, so the two halves must be gated together — and the flag must be
        // recorded before the first buffer moves, because an attach can land
        // the moment the pipeline starts.
        expect(runnerSource).toContain(
            'gst_bus_stamper.enable(pipeline, data.get("timeSyncContract"))',
        );
        const armIdx = runnerSource.indexOf('gst_bus_stamper.enable(pipeline,');
        const playIdx = runnerSource.indexOf('ret = pipeline.set_state(Gst.State.PLAYING)');
        expect(armIdx).toBeGreaterThan(0);
        expect(armIdx).toBeLessThan(playIdx);
    });

    it('the stamper probe is armed lazily — per tee, from the bus_attach path', () => {
        // Arming every busout_* tee at start made a producer pay a per-buffer
        // TS scan for consumers it might not have: measured on .42 (2026-08-12)
        // an idle-but-flowing rist-input with NO edges attached burned 2492
        // ticks/min, 83% of the contract's whole CPU cost. `bus_attach` (this
        // side: BusFanoutCoordinator) is therefore what arms a tee, and the
        // last `bus_detach` is what disarms it — so the flag on its own must
        // install nothing. The eager tree-walk must not come back.
        expect(runnerProcess).not.toContain('def _install_bus_stampers');
        expect(stamperSource).toContain('def arm(tee, name)');
        expect(stamperSource).toContain('def release(tee_name)');
        expect(runnerSource).toContain('def _release_bus_stamper');
        // Armed from the attach path, before the branch is linked...
        const attachIdx = runnerSource.indexOf('def _try_bus_attach');
        const armIdx = runnerSource.indexOf('gst_bus_stamper.arm(tee, tee_name)', attachIdx);
        const linkIdx = runnerSource.indexOf('tee_src = tee.request_pad_simple', attachIdx);
        expect(armIdx).toBeGreaterThan(attachIdx);
        expect(armIdx).toBeLessThan(linkIdx);
        // ...and released from the teardown path, which is what `bus_detach`
        // (and the stall watchdog's edge reset) funnels through.
        const teardownIdx = runnerSource.indexOf('def _teardown_bus_branch');
        expect(runnerSource.indexOf('_release_bus_stamper(entry.get("tee_name"))', teardownIdx))
            .toBeGreaterThan(teardownIdx);
    });

    it('the stamper rewrites DTS as well as PTS', () => {
        // tsdemux reads GST_BUFFER_DTS_OR_PTS — DTS first. Stamping PTS alone
        // is silently a no-op end to end (mutation-checked in
        // gst_bus_stamper_test.py: dropping this line moves the consumer's
        // timeline by ~2 days).
        expect(stamperSource).toContain('buf.pts = pos');
        expect(stamperSource).toContain('buf.dts = pos');
    });

    it('the native stamper is preferred, resolved scoped, and falls back to the probe', () => {
        // The stamping arithmetic now ships twice: the python probe above and
        // the `mrtsstamp` element (plugins/mpegts-core/native/mrtsstamp). Three
        // things must hold or the split becomes a liability rather than a CPU
        // win.
        //
        // 1. The plugin is loaded from a SCOPED path — the same two roots
        //    `resolveNativeBinary` uses for the owning plugin — and never via
        //    GST_PLUGIN_PATH, which would scan it into every GStreamer process
        //    on the box.
        expect(stamperSource).toContain('Gst.Plugin.load_file(path)');
        expect(stamperSource).toContain('"mpegts-core", "native", "mrtsstamp", so');
        expect(stamperSource).toContain(
            'os.environ.get("MR_LIBEXEC_DIR") or "/usr/libexec/media-router"',
        );
        expect(runnerProcess).not.toMatch(/environ\[["']GST_PLUGIN_PATH/);
        // 2. A load failure is a WARNING and the python probe runs unchanged.
        //    The probe is the fallback, so it must not be deleted.
        expect(stamperSource).toContain('falling back to the python probe');
        expect(stamperSource).toContain('import ts_timeline  # lazy, pure stdlib');
        // 3. Both backends emit the SAME engine events, from one builder each —
        //    two copies of these dicts is exactly where the promise that
        //    nothing downstream can tell them apart would break.
        expect(stamperSource).toContain('def anchor_event(tee, ev)');
        expect(stamperSource).toContain('def reanchor_event(tee, ev)');
        expect(runnerProcess.match(/"event": "timeline_restamped"/g)).toHaveLength(1);
        expect(runnerProcess.match(/"event": "timeline_reanchor"/g)).toHaveLength(1);
    });

    it('the runner-side probe runs ts_timeline.TimelineStamper, not its own copy', () => {
        // The probe used to re-implement the contract's arithmetic as closures
        // over a state dict WHILE importing the module that defines it — two
        // python definitions of one contract, free to drift apart silently.
        // The probe now instantiates the shared class and only supplies the
        // GStreamer parts (where the stamp lands, when it arms, how its events
        // get out), so ts_timeline is the single python definition and a break
        // in it fails the probe suite too (mutation-checked).
        expect(stamperSource).toContain('ts_timeline.TimelineStamper(on_anchor=on_anchor,');
        expect(stamperSource).toContain('stamper.stamp(');
        // None of the maths may be restated here: no anchor/floor bookkeeping,
        // no wrap-unwrap, no discontinuity thresholds.
        expect(stamperSource).not.toContain('unwrap_near');
        expect(stamperSource).not.toContain('PTS_WRAP');
        expect(stamperSource).not.toContain('pts90k_to_ns');
        expect(stamperSource).not.toContain('_FWD_TICKS');
        expect(stamperSource).not.toContain('TimelineLatch');
        expect(runnerProcess).not.toContain('def scan_stamp');
    });

    it('the native stamper is spliced by element API, leaving the pipeline strings alone', () => {
        // `buildBusSink` is untouched: with the contract off a producer builds
        // exactly the graph it built before this existed. The element is added
        // between the capsfilter and the tee — BEFORE the fan-out, so one stamp
        // serves every consumer edge and no branch pays a copy for a shared
        // buffer.
        expect(buildBusSink(41000)).toBe(
            'capssetter caps="video/mpegts, systemstream=(boolean)true, packetsize=(int)188" replace=true ! ' +
                'capsfilter caps="video/mpegts, systemstream=(boolean)true, packetsize=(int)188" ! ' +
                'tee name=busout_41000 allow-not-linked=true',
        );
        expect(runnerProcess).not.toContain('mrtsstamp !');
        expect(stamperSource).toContain('def insert_elements(pipe)');
        expect(stamperSource).toContain('Gst.ElementFactory.make("mrtsstamp"');
        // Spliced onto the tee's SINK peer (the capsfilter), not a src branch.
        expect(stamperSource).toContain('sink = tee.get_static_pad("sink")');
        expect(stamperSource).toContain('peer.link(stamp.get_static_pad("sink"))');
        expect(stamperSource).toContain('stamp.get_static_pad("src").link(sink)');
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
