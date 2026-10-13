import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    BUS_TS_CAPS,
    BUS_WATCHDOG_PREFIX,
    buildBusSink,
    buildBusSrc,
    busStallWatch,
    busTeeName,
    latInName,
    latOutName,
} from './busHelpers.js';
import { BACKLOG_SHED_EVENT } from './backlogShed.js';

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

    it('the runner-side input stall watch reads the field the parent sends, and tags like the element did', () => {
        // PipelineDescription.inputStallWatch → GstChildProcess.startPayload →
        // handle_start's data.get("inputStallWatch"). A rename on any hop
        // silently disables dark-input recovery on the muxer.
        const childProcess = readFileSync(
            join(__dirname, '..', 'child-process', 'GstChildProcess.ts'),
            'utf8',
        );
        expect(childProcess).toContain('inputStallWatch: desc.inputStallWatch');
        expect(runnerSource).toContain('data.get("inputStallWatch")');
        // The mechanism lives in its own module; the runner aliases it.
        expect(runnerSource).toContain('import gst_input_stall_watch as input_stall');
        const stallWatch = readFileSync(
            join(__dirname, '..', 'child-process', 'gst_input_stall_watch.py'),
            'utf8',
        );
        // Same error shape as the `watchdog` element path: kind + prefixed element.
        expect(stallWatch).toContain(`ELEMENT_PREFIX = "${BUS_WATCHDOG_PREFIX}_"`);
        expect(stallWatch).toContain('"element": ELEMENT_PREFIX + name');
        expect(stallWatch).toContain('"kind": "bus_stall"');
        expect(busStallWatch('busin_0', 5000)).toEqual({ element: 'busin_0', timeoutMs: 5000 });
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

    it('the runner puts every pipeline on the house clock', () => {
        // §4.1: `base_time = 0` on a monotonic clock in every process, with no
        // flag to read and no other arm, so `now − PTS` is house lateness.
        expect(runnerSource).toContain('def _apply_contract_clock');
        expect(runnerSource).toContain(
            '    _apply_contract_clock(pipeline, data.get("liveCaptureClock"))\n',
        );
        // The three moves that make running-time ≡ house-clock time (ADR-0005):
        // a fixed monotonic system clock and a pinned timeline.
        expect(runnerSource).toContain('Gst.ClockType.MONOTONIC');
        expect(runnerSource).toContain('pipe.set_start_time(Gst.CLOCK_TIME_NONE)');
        expect(runnerSource).toContain('pipe.set_base_time(0)');
        // …and the live-capture variant that keeps the clock but skips the
        // pinning. The skip must sit BEFORE both pin calls — placed after
        // either one the flag reads as implemented and changes nothing, which
        // is exactly the mis-schedule it exists to fix (video-encoder's
        // `v4l2src ! … ! mpegtsmux` bursting on a Pi4 + ATEM).
        const skipIdx = runnerSource.indexOf('    if live_capture_clock:\n');
        expect(skipIdx).toBeGreaterThan(0);
        expect(skipIdx).toBeLessThan(
            runnerSource.indexOf('pipe.set_start_time(Gst.CLOCK_TIME_NONE)'),
        );
        expect(skipIdx).toBeLessThan(runnerSource.indexOf('pipe.set_base_time(0)'));
    });

    it('there is no net clock arm left in the runner', () => {
        expect(runnerSource).not.toContain('_apply_net_clock');
        expect(runnerSource).not.toContain('GstNet');
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

    it('the stamper is enabled on every pipeline, before PLAYING', () => {
        // Enabled before the first buffer moves, because an attach can land
        // the moment the pipeline starts.
        expect(runnerSource).toContain(
            'gst_bus_stamper.enable(pipeline, data.get("latchRepair"),\n' +
                '                           data.get("conditionStepMs"), data.get("houseTimelineEgress"))',
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
        // last `bus_detach` is what disarms it — so `enable` on its own must
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
        expect(
            runnerSource.indexOf('_release_bus_stamper(entry.get("tee_name"))', teardownIdx),
        ).toBeGreaterThan(teardownIdx);
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
        // `buildBusSink` is untouched. The element is added between the
        // capsfilter and the tee — BEFORE the fan-out, so one stamp serves
        // every consumer edge and no branch pays a copy for a shared buffer.
        expect(buildBusSink(41000)).toBe(
            'capssetter caps="video/mpegts, systemstream=(boolean)true, packetsize=(int)188" replace=true ! ' +
                'capsfilter caps="video/mpegts, systemstream=(boolean)true, packetsize=(int)188" ! ' +
                'mrlateness name=lat_busout_41000 reference=house ! ' +
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

    it('the runner implements the backlogShed start option', () => {
        // Both presentation legs send `backlogShed` under the contract
        // (backlogShedConfig → PipelineDescription → GstChildProcess
        // startPayload → runner). Silently losing the key (the
        // decoderThreadType trap) would leave every paced leg on the latency
        // ratchet with nothing to notice it: the picture decays over HOURS and
        // the pipeline reports itself healthy the whole time.
        expect(runnerSource).toContain('data.get("backlogShed")');
        expect(runnerSource).toContain('def _start_backlog_shedder');
        // Every field of the config the TS side sends is read by name.
        for (const key of [
            'element',
            'sink',
            'keyframeAligned',
            'toleranceMs',
            'holdMs',
            'cooldownMs',
            'sanityMs',
        ]) {
            expect(runnerSource).toContain(`cfg.get("${key}"`);
        }
    });

    it('the shedder reports on the channel GstPluginBase logs', () => {
        // One literal, two processes: the runner emits it, the base class logs
        // every leg's episodes off it.
        expect(runnerSource).toContain(`emit_plugin_event("${BACKLOG_SHED_EVENT}"`);
        expect(runnerSource).toContain('"outcome": outcome');
    });

    it("the shedder measures against the SINK's live ts-offset, not a copy of D", () => {
        // The route's playout offset moves live (`notifyPlayoutOffsetChanged`
        // pushes a new `ts-offset` to the running sink). Reading the property
        // is what keeps the guard measuring against the budget the route is
        // actually presenting on, instead of one baked in at pipeline build.
        expect(runnerSource).toContain('sink.get_property("ts-offset")');
    });

    it('the shedder is armed AFTER the keyframe gate on the same pad', () => {
        // A probe returning DROP stops the rest of the chain being called, so
        // order decides who wins when both are on the decoder's sink pad. A
        // shut gate must: it is already dropping everything, which drains the
        // same backlog, and its rule is the safety-critical one.
        const gateIdx = runnerSource.indexOf(
            '_start_keyframe_gate(pipeline, data.get("keyframeGate"))',
        );
        const shedIdx = runnerSource.indexOf(
            '_start_backlog_shedder(pipeline, data.get("backlogShed"))',
        );
        expect(gateIdx).toBeGreaterThan(0);
        expect(shedIdx).toBeGreaterThan(gateIdx);
    });

    it('a backlogShed naming an element the pipeline lacks is a HARD error', () => {
        expect(runnerSource).toContain('"backlogShed: element not found:');
        expect(runnerSource).toContain('"backlogShed: sink not found:');
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

    describe('lateness taps (house-clock WI-P0-8)', () => {
        const nativeDir = join(__dirname, '..', '..', 'native', 'mr-gst-runner');
        const native = ['runner.cpp', 'main.cpp', 'lateness_tap.cpp', 'stamper.cpp']
            .map((f) => readFileSync(join(nativeDir, f), 'utf8'))
            .join('\n');
        const pyLoader = readFileSync(
            join(__dirname, '..', 'child-process', 'gst_lateness_native.py'),
            'utf8',
        );

        it('tap names: ingress lat_busin…, egress after the tee the runners address', () => {
            expect(latInName('busin')).toBe('lat_busin');
            expect(latOutName(41000)).toBe(`lat_${busTeeName(41000)}`);
            expect(buildBusSrc({ port: 41000, name: 'busin_3' })).toContain(
                'mrlateness name=lat_busin_3 reference=house',
            );
            expect(buildBusSink(41000)).toContain(`mrlateness name=${latOutName(41000)}`);
        });

        it('both runners forward mrlateness unsubscribed, as mrlateness:<tap>', () => {
            expect(runnerSource).toContain('elif name == "mrlateness" and src_name:');
            expect(runnerSource).toContain(
                'emit_plugin_event(f"mrlateness:{src_name}", gst_structure_to_dict(structure))',
            );
            expect(native).toContain('std::strcmp(name, lateness::MESSAGE) == 0');
            expect(native).toContain('emit_plugin_event(std::string("mrlateness:") + src_name');
            // Ahead of the busReports branch: no subscription is consulted.
            expect(runnerSource.indexOf('elif name == "mrlateness"')).toBeLessThan(
                runnerSource.indexOf('(src_name, name) in bus_reports'),
            );
        });

        it('both runners load libgstmrlateness.so by path at start, never GST_PLUGIN_PATH', () => {
            expect(runnerSource).toContain('    gst_lateness_native.load_plugin()\n');
            expect(pyLoader).toContain('Gst.Plugin.load_file(path)');
            expect(pyLoader).toContain('"mpegts-core", "native", "mrlateness", SO_NAME');
            expect(native).toContain('mr::lateness::load_plugin();');
            expect(native).toContain('paths::asset_candidates("mpegts-core", "mrlateness", so)');
            expect(native).toContain('gst_plugin_load_file(path.c_str(), &err)');
            expect(pyLoader).not.toMatch(/GST_PLUGIN_PATH["']\]/);
        });

        it('the loader ships with the runner in the engine build', () => {
            // dist/child-process is what runs on a box; a module the runner
            // imports but the build does not copy kills every python runner.
            const pkg = readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8');
            for (const m of runnerSource.matchAll(/^import (gst_\w+)/gm)) {
                expect(pkg).toContain(`src/child-process/${m[1]}.py`);
            }
            expect(pkg).toContain('src/child-process/gst_lateness_native.py');
        });

        it('the stamp splices in front of the egress tap, so the tap reads stamped PTS', () => {
            expect(stamperSource).toContain('("capssetter", "capsfilter", "mrlateness")');
            expect(native).toContain('fname != "mrlateness"');
        });

        it('the protocol test drives the exact buildBusSrc and buildBusSink fragments', () => {
            const py = readFileSync(
                join(__dirname, '..', 'child-process', 'gst_lateness_protocol_test.py'),
                'utf8',
            );
            const template = /BUS_SRC = \(((?:"[^"]*"\s*)+)\)/.exec(py)?.[1] ?? '';
            const literal = [...template.matchAll(/"([^"]*)"/g)].map((m) => m[1]).join('');
            const socket = '/tmp/mrlat/a.sock';
            expect(literal.replace(/\{name\}/g, 'busin').replace('{socket}', socket)).toBe(
                buildBusSrc({ name: 'busin', port: 41000, socketPath: socket }),
            );
            // BUS_SINK: an f-string over TS_CAPS with escaped quotes, one literal per line.
            const sinkBlock = /BUS_SINK = \(([\s\S]*?)\)\n/.exec(py)?.[1] ?? '';
            const sinkLiteral = sinkBlock
                .split('\n')
                .map((l) => /f?"(.*)"\s*$/.exec(l.trim())?.[1] ?? '')
                .join('')
                .replace(/\\"/g, '"')
                .replace(/\{TS_CAPS\}/g, BUS_TS_CAPS);
            expect(sinkLiteral).toBe(buildBusSink(41000));
        });
    });
});
