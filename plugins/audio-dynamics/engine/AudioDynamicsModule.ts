import {
    GstPluginBase,
    findLadspaElement,
    type PipelineDescription,
} from '@media-router/engine';

/**
 * Audio Dynamics plugin — ducker / compressor / gate with external sidechain.
 *
 * Topology (all modes): two input null-sinks (program + sidechain) and one
 * output null-sink; downstream modules read `<out>.monitor`.
 *
 * - **ducker**: a `level` on the sidechain keys a `volume` on the program path.
 *   The runner reports the sidechain level (generic `levelReports`) to
 *   `onPluginEvent` (channel `level:sclevel`); this module owns the gain
 *   envelope in TS and rides the `volume` element via `setElementProperty`.
 *   Gives an EXACT duck floor with independent attack / release / hold, needs
 *   only stock `level`/`volume` (no LADSPA — runs on any image). This is the
 *   broadcast-standard ducker; the compressor's dry/wet floor trick could not
 *   deliver a predictable release.
 * - **compressor / gate**: real DSP via the LSP LADSPA sidechain compressor /
 *   gate (two stereo monitors → deinterleave → 4-ch interleave; program on
 *   0/1, key on 2/3; lookahead 0 = zero added latency). Needs the gst `ladspa`
 *   wrapper + lsp-plugins-ladspa on the host.
 *
 * LADSPA element names embed the library version, so they're resolved from the
 * registry at start (`findLadspaElement`), never hardcoded.
 */

const dbToGain = (db: number): number => 10 ** (db / 20);
/** Format a gain factor for the pipeline string / set_property. */
const g = (db: number): number => Number(dbToGain(db).toFixed(6));

const COMPRESSOR_SUFFIX = 'sc-compressor-stereo';
const GATE_SUFFIX = 'sc-gate-stereo';

/** LSP live-prop maps for the LADSPA modes: config key → property + conversion. */
const LIVE_PROP_MAPS: Record<
    'compressor' | 'gate',
    Record<string, { prop: string; convert: (v: unknown) => number }>
> = {
    compressor: {
        threshold: { prop: 'attack-threshold', convert: (v) => g(Number(v)) },
        ratio: { prop: 'ratio', convert: (v) => Number(v) },
        attack: { prop: 'attack-time', convert: (v) => Number(v) },
        release: { prop: 'release-time', convert: (v) => Number(v) },
        knee: { prop: 'knee', convert: (v) => g(Number(v)) },
        makeupGain: { prop: 'makeup-gain', convert: (v) => g(Number(v)) },
    },
    gate: {
        threshold: { prop: 'curve-threshold', convert: (v) => g(Number(v)) },
        gateDepth: { prop: 'reduction', convert: (v) => g(Number(v)) },
        attack: { prop: 'attack', convert: (v) => Number(v) },
        release: { prop: 'release', convert: (v) => Number(v) },
        makeupGain: { prop: 'makeup-gain', convert: (v) => g(Number(v)) },
        gateKey: { prop: 'sidechain-input', convert: (v) => (v === 'sidechain' ? 1 : 0) },
    },
};

export class AudioDynamicsModule extends GstPluginBase {
    protected liveUpdatableParams = [
        'threshold',
        'duckDepth',
        'ratio',
        'attack',
        'release',
        'knee',
        'makeupGain',
        'gateDepth',
        'gateKey',
        'hold',
    ];

    /** Resolved gst element name for the active LADSPA mode (version-dependent). */
    private dynElement: string | null = null;
    private meterTimer: ReturnType<typeof setInterval> | null = null;
    private lastGrDb = 0;

    // Ducker gain envelope (ducker mode). Advanced on each sidechain level
    // reading; reads params live from `this.config` so slider changes need no
    // pipeline restart or extra IPC.
    private duckDb = 0; // current applied gain, dB (0 = unity)
    private duckActiveMs = -Infinity; // last time the key was over threshold
    private duckTickMs = 0; // last envelope tick (Date.now)
    private duckSetGain = 1; // last volume actually pushed to the element

    private get mode(): 'ducker' | 'compressor' | 'gate' {
        const m = this.config.mode as string;
        return m === 'compressor' || m === 'gate' ? m : 'ducker';
    }

    /** Overridable for tests — resolves the LADSPA element from the registry. */
    protected resolveDynElement(suffix: string): Promise<string | null> {
        return findLadspaElement(suffix);
    }

    async onStart(): Promise<void> {
        const pw = this.services?.pipeWire;
        if (!pw) throw new Error('PipeWire not available');
        const instanceId = this.services!.instanceId;

        // LADSPA modes resolve their DSP element up front; ducker needs none.
        if (this.mode !== 'ducker') {
            const suffix = this.mode === 'gate' ? GATE_SUFFIX : COMPRESSOR_SUFFIX;
            this.dynElement = await this.resolveDynElement(suffix);
            if (!this.dynElement) {
                throw new Error(
                    `LADSPA element *-${suffix} not found — install lsp-plugins-ladspa ` +
                        `and the GStreamer ladspa wrapper (gst-plugins-bad)`,
                );
            }
        }

        for (const name of ['prog', 'sc', 'out']) {
            await pw.loadNullSink(`${instanceId}_${name}`, 2, 48000, instanceId);
            await pw.setSinkVolume(`MR_PW_${instanceId}_${name}`, 100);
        }
        for (const name of ['prog', 'sc', 'out']) {
            await pw.waitForSink(`MR_PW_${instanceId}_${name}`);
        }

        await super.onStart();
        if (this.mode !== 'ducker') this.startMeterPoll();
    }

    /**
     * Re-seed on every PLAYING, including a crash-restart that rebuilds the
     * pipeline from the original string. Ducker: reset the envelope so it
     * re-converges from unity (the fresh `volume` element is at 1.0). LADSPA
     * modes: re-apply the current live config to the fresh element, since the
     * restart's baked-in string carries only start-time values.
     */
    protected onPipelinePlaying(): void {
        if (this.mode === 'ducker') {
            this.duckDb = 0;
            this.duckActiveMs = -Infinity;
            this.duckTickMs = Date.now();
            this.duckSetGain = 1;
            return;
        }
        const map = LIVE_PROP_MAPS[this.mode];
        for (const [key, { prop, convert }] of Object.entries(map)) {
            void this.setElementProperty('dyn', prop, convert(this.config[key] ?? this.defaultFor(key)));
        }
    }

    async onStop(): Promise<void> {
        if (this.meterTimer) {
            clearInterval(this.meterTimer);
            this.meterTimer = null;
        }
        this.dynElement = null;
        await super.onStop();
        // PipeWire null-sinks are released automatically via ownership tracking
    }

    async onLiveConfigUpdate(changes: Record<string, unknown>): Promise<void> {
        Object.assign(this.config, changes);

        // Ducker params are read live by the envelope (onPluginEvent) straight
        // from this.config — nothing more to do here.
        if (this.mode === 'ducker') return;

        const map = LIVE_PROP_MAPS[this.mode];
        for (const [key, value] of Object.entries(changes)) {
            const entry = map[key];
            if (entry) await this.setElementProperty('dyn', entry.prop, entry.convert(value));
        }
    }

    /**
     * Sidechain level → gain envelope (ducker mode). Fires on the generic
     * `level:sclevel` channel (~15 ms). Ramps the applied gain in the dB domain
     * toward an exact floor with independent attack/release/hold, all read live
     * from config. The `volume` element is only written when the gain actually
     * moves, so a steady (open or fully-ducked) state costs no IPC.
     */
    protected onPluginEvent(channel: string, payload: unknown): void {
        if (this.mode !== 'ducker' || channel !== 'level:sclevel') return;
        const rms = (payload as { rms?: number[] })?.rms;
        if (!rms?.length) return;
        const cfg = this.config;
        const threshold = Number(cfg.threshold ?? -35);
        const floor = Number(cfg.duckDepth ?? -12); // negative dB
        const attack = Math.max(1, Number(cfg.attack ?? 5));
        const release = Math.max(1, Number(cfg.release ?? 200));
        const hold = Math.max(0, Number(cfg.hold ?? 250));

        const now = Date.now();
        const dt = Math.min(100, Math.max(1, now - this.duckTickMs));
        this.duckTickMs = now;

        const keyDb = Math.max(...rms);
        if (keyDb > threshold) this.duckActiveMs = now;
        const active = keyDb > threshold || now - this.duckActiveMs < hold;
        const target = active ? floor : 0;

        if (this.duckDb > target) {
            this.duckDb = Math.max(target, this.duckDb - (Math.abs(floor) / attack) * dt);
        } else if (this.duckDb < target) {
            this.duckDb = Math.min(target, this.duckDb + (Math.abs(floor) / release) * dt);
        }

        const gain = 10 ** (this.duckDb / 20);
        if (Math.abs(gain - this.duckSetGain) > 0.0005) {
            this.duckSetGain = gain;
            void this.setElementProperty('duckvol', 'volume', Number(gain.toFixed(4)));
        }
    }

    getPipeWireNodeForPort(portId: string): { source?: string; sink?: string } {
        const instanceId = this.services?.instanceId ?? '';
        switch (portId) {
            case 'program-in':
                return { sink: `MR_PW_${instanceId}_prog` };
            case 'sidechain-in':
                return { sink: `MR_PW_${instanceId}_sc` };
            case 'audio-out':
                return { source: `MR_PW_${instanceId}_out.monitor` };
            default:
                return {};
        }
    }

    getPipeWireNodes(): { source?: string; sink?: string } {
        return {};
    }

    buildPipeline(config: Record<string, unknown>): PipelineDescription | null {
        const instanceId = this.services?.instanceId ?? '';
        const outSink =
            `pulsesink device=MR_PW_${instanceId}_out sync=false slave-method=0 ` +
            `processing-deadline=100000000 buffer-time=50000 max-lateness=200000000`;

        if (this.mode === 'ducker') return this.buildDuckerPipeline(config, instanceId, outSink);
        return this.buildLadspaPipeline(config, instanceId, outSink);
    }

    /**
     * Ducker: `sclevel` (sidechain) reported to onPluginEvent keys `duckvol`
     * (program). Stock elements only — the gain envelope lives in this module.
     */
    private buildDuckerPipeline(
        _config: Record<string, unknown>,
        instanceId: string,
        outSink: string,
    ): PipelineDescription {
        const parts = [
            // Program path: onPluginEvent rides `duckvol`; `outlevel` feeds the VU meter
            `pulsesrc device=MR_PW_${instanceId}_prog.monitor ! audioconvert ! ` +
                `volume name=duckvol ! ` +
                `level name=outlevel post-messages=true peak-falloff=120 peak-ttl=50000000 interval=100000000 ! ` +
                outSink,
            // Sidechain detector: fast level readings key the envelope (reported, not VU)
            `pulsesrc device=MR_PW_${instanceId}_sc.monitor ! audioconvert ! ` +
                `level name=sclevel post-messages=true interval=15000000 ! fakesink sync=false`,
        ];
        return {
            pipeline: parts.join(' '),
            restartOnError: true,
            busReports: [{ element: 'sclevel', structure: 'level' }],
        };
    }

    /** Compressor / gate: LSP LADSPA element fed by a 4-channel interleave. */
    private buildLadspaPipeline(
        config: Record<string, unknown>,
        instanceId: string,
        outSink: string,
    ): PipelineDescription | null {
        if (!this.dynElement) return null;
        const map = LIVE_PROP_MAPS[this.mode === 'gate' ? 'gate' : 'compressor'];

        const props: string[] = [];
        if (this.mode === 'compressor') {
            props.push('sidechain-type=0', 'sidechain-preamp=1.0');
        }
        for (const [key, { prop, convert }] of Object.entries(map)) {
            props.push(`${prop}=${convert(config[key] ?? this.defaultFor(key))}`);
        }

        const stereoCaps = 'audio/x-raw,format=F32LE,channels=2,rate=48000';
        const parts = [
            `pulsesrc device=MR_PW_${instanceId}_prog.monitor ! ${stereoCaps},channel-mask=(bitmask)0x3 ! deinterleave name=dp`,
            `pulsesrc device=MR_PW_${instanceId}_sc.monitor ! ${stereoCaps},channel-mask=(bitmask)0x3 ! deinterleave name=ds`,
            [
                'interleave name=il',
                'audioconvert',
                'audio/x-raw,channels=4,channel-mask=(bitmask)0x0',
                `${this.dynElement} name=dyn ${props.join(' ')}`,
                'audioconvert',
                'level post-messages=true peak-falloff=120 peak-ttl=50000000 interval=100000000',
                outSink,
            ].join(' ! '),
            'dp.src_0 ! queue ! il.sink_0',
            'dp.src_1 ! queue ! il.sink_1',
            'ds.src_0 ! queue ! il.sink_2',
            'ds.src_1 ! queue ! il.sink_3',
        ];
        // Live changes are applied directly via setElementProperty and
        // re-applied on restart by onPipelinePlaying — no liveElements field
        // (the engine reads none; declaring it would imply a guarantee it
        // doesn't provide).
        return {
            pipeline: parts.join(' '),
            restartOnError: true,
        };
    }

    /** Schema defaults for keys absent from config (fresh instances). */
    private defaultFor(key: string): number | string {
        const defaults: Record<string, number | string> = {
            threshold: -35,
            duckDepth: -12,
            ratio: 8,
            attack: 5,
            release: 200,
            knee: -6,
            makeupGain: 0,
            gateDepth: -48,
            gateKey: 'self',
            hold: 250,
        };
        return defaults[key];
    }

    /**
     * Poll the LSP DSP meters (1 Hz) into the status popup and a face badge.
     * LADSPA modes only — the ducker's reduction lives in the runner and its
     * program level is already visible on the VU meter.
     */
    private startMeterPoll(): void {
        if (this.meterTimer) clearInterval(this.meterTimer);
        this.lastGrDb = 0;
        this.meterTimer = setInterval(async () => {
            const red = (await this.getElementProperty('dyn', 'reduction-level-meter')) as
                | number
                | undefined;
            if (typeof red !== 'number') return;
            const grDb = red > 0 ? 20 * Math.log10(red) : -99;
            if (Math.abs(grDb - this.lastGrDb) < 0.5) return;
            this.lastGrDb = grDb;

            const key = (await this.getElementProperty('dyn', 'sidechain-level-meter')) as
                | number
                | undefined;
            const keyDb = typeof key === 'number' && key > 0 ? 20 * Math.log10(key) : null;
            this.setStatusData('dynamics', {
                gainReduction: `${grDb.toFixed(1)} dB`,
                keyLevel: keyDb === null ? '—' : `${keyDb.toFixed(1)} dB`,
                element: this.mode === 'gate' ? 'LSP Sidechain Gate' : 'LSP Sidechain Compressor',
            });
            if (grDb < -1) {
                this.setBadge('gr', { icon: 'activity', text: `${grDb.toFixed(0)} dB`, color: '#f59e0b' });
            } else {
                this.clearBadge('gr');
            }
        }, 1000);
    }
}
