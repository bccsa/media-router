import {
    BUS_TS_CAPS,
    GstPluginBase,
    UnixFdFanoutController,
    busIngestSocketPath,
    formatBytes,
    resolveNativeBinary,
    resolvePythonScript,
    type BusAttachTarget,
    type PipelineDescription,
} from '@media-router/engine';
import type { ManagedProcess } from '@media-router/engine';
import type { AlternateRendition } from 'hls-pipe';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { classifyOriginFailure, originFailureMessage } from './originFailure.js';
import { resolutionCapBitrateBps, resolveQuality } from './runnerOptions.js';

/**
 * Locate the compiled runner. `__dirname` is `dist/` in production, but the
 * `engine/` source dir when PluginLoader falls back to importing the `.ts`
 * under tsx — the compiled runner then lives in the sibling `dist/`.
 */
function resolveRunnerPath(): string | null {
    const candidates = [
        join(__dirname, 'hls-pipe-runner.js'),
        join(__dirname, '..', 'dist', 'hls-pipe-runner.js'),
    ];
    return candidates.find((p) => existsSync(p)) ?? null;
}

/**
 * How to launch the GstUnixFd fan-out. Prefers the native `mr-bus-fanout`
 * binary (unixfdbus-core library plugin) and falls back to its python sidecar,
 * which speaks the identical CLI, control verbs and events — the two are
 * interchangeable and the conformance suite runs both against the same
 * protocol clients. Returns null when neither is present.
 */
function resolveFanout(): { command: string; prefix: string[]; label: string } | null {
    const native = resolveNativeBinary('mr-bus-fanout', 'hls-player');
    if (native) return { command: native, prefix: [], label: 'mr-bus-fanout' };
    const script = resolvePythonScript('unixfd-fanout.py', 'hls-player');
    if (script) return { command: 'python3', prefix: [script], label: 'unixfd-fanout' };
    return null;
}

type Option = { value: string; label: string };

/** Collapse a rendition list to unique selectable languages (by LANGUAGE, falling back to NAME). */
function langOptions(renditions: AlternateRendition[]): Option[] {
    const seen = new Map<string, string>();
    for (const r of renditions) {
        const value = (r.language ?? r.name ?? '').trim();
        if (!value || seen.has(value)) continue;
        seen.set(value, r.language && r.name ? `${r.name} (${r.language})` : r.name || value);
    }
    return [...seen].map(([value, label]) => ({ value, label }));
}

/**
 * Coerce a config value (array or comma string) to a clean **string** array.
 * Drops non-string entries silently — defends the runner against stale stored
 * config like `[{}, {}]` (e.g. left over from a previous schema rev where the
 * field rendered as a generic array of objects). Without this, `String({})`
 * would yield the literal `"[object Object]"` and crash-loop hls-pipe with
 * `inlineAudioLanguages: none of [[object Object],...] found in master.audio`.
 */
function asArray(v: unknown): string[] {
    if (Array.isArray(v)) {
        return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
    }
    if (typeof v === 'string' && v.trim()) {
        return v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
    }
    return [];
}

/**
 * HLS Player plugin.
 *
 * Pulls an HLS stream via the hls-pipe library (spawned as an isolated Node
 * child by `hls-pipe-runner.ts`) and re-broadcasts canonical MPEG-TS on the
 * inter-module bus — same producer contract as srt-input. The child streams
 * into this module's fan-out sidecar (the native `mr-bus-fanout`, or the
 * python `unixfd-fanout.py` when the binary is absent), which serves the
 * per-consumer edge sockets speaking the GstUnixFd protocol (see
 * `startFanout`).
 *
 * On start it probes the master playlist to detect available audio / subtitle
 * languages and reports them as `fieldOptions`, so the settings panel can show
 * language selectors populated from the actual stream. URL changes apply live
 * (re-probe + relaunch the runner); language / quality changes need a module
 * restart — see `getLiveUpdatableParams()`.
 */
export class HlsPlayerModule extends GstPluginBase {
    private runner: ManagedProcess | null = null;
    /** The GstUnixFd fan-out sidecar + its controller. The sidecar owns the
     *  per-consumer edge sockets, so they survive runner relaunches (URL
     *  changes) — consumers see a data gap, not a disconnect. */
    private fanout: ManagedProcess | null = null;
    private fanoutController: UnixFdFanoutController | null = null;
    private playlistKind = '—';
    /** Variant ladder from the last master-playlist probe (bitrate + height),
     *  used to turn a `maxHeight` ceiling into a bitrate cap. Empty for media
     *  playlists or a failed probe. */
    private masterVariants: Array<{ bitrate: number; resolution?: { height: number } }> = [];
    /** Serializes live config updates — see `onLiveConfigUpdate`. */
    private updateLock: Promise<void> = Promise.resolve();
    /** Latched operator-facing origin failure (see `noteOriginFailure`), or
     *  null while the origin is behaving. */
    private originFailure: string | null = null;
    /** Consecutive non-auth fetch failures since bytes last flowed. */
    private fetchFailures = 0;

    async onStart(): Promise<void> {
        this.log.info(
            {
                hasMediaRouter: !!this.services?.mediaRouter,
                hasProcessManager: !!this.services?.processManager,
            },
            'onStart',
        );
        // A restart is fresh evidence: whatever the origin did last time is
        // no longer a fact about this run.
        this.clearOriginFailure();
        if (!this.services?.mediaRouter) {
            this.setHealth('error', 'mediaRouter service unavailable');
            return;
        }

        // Reserve the bus channel up front (same as encoders) so a URL
        // pasted later — applied live — can launch the runner without a restart.
        // Only `mediaRouter` is required for this; `processManager` is checked
        // later, when we actually need to spawn the runner.
        this.services.mediaRouter.assignBusChannel(this.services.instanceId);
        const endpoint = this.services.mediaRouter.getBusChannel(this.services.instanceId);
        if (!endpoint) {
            this.setHealth('error', 'No bus channel assigned — cannot output MPEG-TS');
            return;
        }

        // The fan-out sidecar must run even while idle: it owns the
        // per-consumer edge sockets, and consumers gate their start on
        // connecting to them (busSocketGate).
        if (!this.startFanout(endpoint.port)) return;

        this.running = true;
        this.ready = true;

        const url = String(this.config.url ?? '').trim();
        if (!url) {
            // Idle until the operator pastes a URL — not an error. The language
            // selectors populate (and playback starts) on the live URL update.
            this.setHealth('warning', 'Waiting for HLS URL');
            this.updateSourceStatus();
            return;
        }

        // Detect languages so the UI can populate the selectors. Best-effort:
        // a probe failure must not block extraction — the runner surfaces the
        // real error if the URL is genuinely bad.
        await this.probe(url);

        if (!this.services.processManager) {
            this.setHealth('error', 'processManager service unavailable — cannot spawn runner');
            return;
        }
        if (!this.spawnRunner(url, endpoint.port)) return;
        this.setPlayingHealth();
        this.updateSourceStatus();
        // No GStreamer pipeline — the runner feeds the fan-out sidecar.
    }

    async onStop(): Promise<void> {
        // ProcessManager auto-kills the runner + sidecar on module stop; just drop the refs.
        this.runner = null;
        this.fanout = null;
        this.fanoutController = null;
        await super.onStop();
    }

    buildPipeline(): PipelineDescription | null {
        return null;
    }

    /** Bus fan-out commands go to our sidecar controller, not a gst runner
     *  (there is none). */
    getBusAttachTarget(): BusAttachTarget | null {
        return this.fanoutController;
    }

    /**
     * Spawn the GstUnixFd fan-out sidecar.
     * @returns false when it could not be spawned (health already set).
     */
    private startFanout(port: number): boolean {
        if (this.fanout) return true; // restart path — already up
        if (!this.services?.processManager) {
            this.setHealth('error', 'processManager service unavailable — cannot spawn fan-out');
            return false;
        }
        const fanout = resolveFanout();
        if (!fanout) {
            this.setHealth(
                'error',
                'no bus fan-out available — run `make native` (mr-bus-fanout) or pnpm build (see plugins/README.md)',
            );
            return false;
        }
        this.fanoutController = new UnixFdFanoutController(
            () => this.fanout,
            // Every sidecar `ready` (first start and each autoRestart respawn):
            // the controller has replayed its own desired edges; this reattach
            // covers connections created while the module was down, which only
            // the engine-side coordinator knows about.
            () => {
                if (this.services?.instanceId) {
                    this.services.mediaRouter?.onProducerPlaying(this.services.instanceId);
                }
                this.restoreIdleHealth();
            },
        );
        this.fanout = this.spawnRunnerProcess({
            label: fanout.label,
            command: fanout.command,
            args: [
                ...fanout.prefix,
                '--ingest', busIngestSocketPath(port),
                '--caps', BUS_TS_CAPS,
                // Producer half of the time-sync contract: the sidecar stamps
                // the payload's mapped media time instead of send time. Both
                // implementations take the same flag; off ⇒ argv unchanged.
                ...(this.services?.timeSyncContract ? ['--stamp-timeline'] : []),
            ],
            autoRestart: true,
            stdin: true,
            onStdout: (line) => this.handleFanoutLine(line),
            onStderr: (line) => this.log.warn({ src: fanout.label }, line),
        });
        return true;
    }

    private handleFanoutLine(line: string): void {
        const msg = this.fanoutController?.handleLine(line);
        if (!msg) return;
        const stats = msg.stats as { clients?: number; drops?: Record<string, number> } | undefined;
        if (stats) {
            const drops = Object.values(stats.drops ?? {}).reduce((a, b) => a + b, 0);
            this.setStatusData('bus', { consumers: stats.clients ?? 0, 'shed buffers': drops });
        } else if (msg.event === 'error' || msg.event === 'warning') {
            this.log.warn({ src: 'bus-fanout' }, String(msg.message ?? ''));
        }
    }

    /** Re-assert the idle warning after a sidecar respawn set transient
     *  crash/restart health — a URL-less module is 'waiting', not 'ok'. */
    private restoreIdleHealth(): void {
        if (this.running && !String(this.config.url ?? '').trim()) {
            this.setHealth('warning', 'Waiting for HLS URL');
        }
    }

    /**
     * Only URL applies live (re-probes and relaunches the runner). Language
     * selections need a module restart — `onLiveConfigUpdate` wouldn't relaunch
     * mid-stream cleanly for them, and the pending-restart UX is fine there.
     */
    getLiveUpdatableParams(): string[] {
        return ['url'];
    }

    /**
     * Serialized: `probe()` awaits the network mid-flow, and two rapid URL
     * changes interleaving here could each see `runner === null` and spawn two
     * runners onto the same multicast port — corrupting the TS for every
     * consumer. Each update runs strictly after the previous one settles.
     */
    async onLiveConfigUpdate(changes: Record<string, unknown>): Promise<void> {
        const run = this.updateLock.then(() => this.applyLiveUpdate(changes));
        this.updateLock = run.catch(() => {});
        return run;
    }

    private async applyLiveUpdate(changes: Record<string, unknown>): Promise<void> {
        // Snapshot the URL *before* merging so we can tell whether it actually
        // changed. Without this, every config push with `url` present (even
        // unchanged) would re-probe and relaunch the runner — the manager
        // re-syncs config on its own schedule, and a respawn loop ensues.
        const prevUrl = String(this.config.url ?? '').trim();
        await super.onLiveConfigUpdate(changes); // merges into this.config
        const url = String(this.config.url ?? '').trim();

        // Only relaunch on a real URL change. Other live params don't reach us
        // (`getLiveUpdatableParams` returns just `['url']`), but be explicit.
        if (!('url' in changes) || url === prevUrl) return;
        // A new (or re-signed) URL is a new origin question — never carry the
        // old URL's rejection over onto it.
        this.clearOriginFailure();
        if (!this.running || !this.services?.mediaRouter || !this.services.processManager) {
            this.log.warn(
                {
                    running: this.running,
                    hasMediaRouter: !!this.services?.mediaRouter,
                    hasProcessManager: !!this.services?.processManager,
                },
                'onLiveConfigUpdate: cannot launch runner',
            );
            return;
        }

        if (this.runner) {
            await this.services.processManager.kill(this.services.instanceId, this.runner);
            this.runner = null;
        }

        if (!url) {
            // URL cleared — stop multicasting the old stream and go back to idle.
            this.clearBadge('bitrate');
            this.setHealth('warning', 'Waiting for HLS URL');
            this.updateSourceStatus();
            return;
        }

        await this.probe(url);
        // `probe` is an unbounded network fetch — the module can be stopped
        // while it is in flight. Without this re-check we would spawn a runner
        // into an ownership set the engine has already released, leaving it
        // alive and auto-restarting with nothing tracking it.
        if (!this.running) {
            this.log.info('Module stopped during probe — not spawning runner');
            return;
        }
        this.services.mediaRouter.assignBusChannel(this.services.instanceId); // idempotent
        const endpoint = this.services.mediaRouter.getBusChannel(this.services.instanceId);
        if (!endpoint) return;
        if (!this.spawnRunner(url, endpoint.port)) return;
        this.setPlayingHealth();
        this.updateSourceStatus();
    }

    /** @returns false when the runner could not be spawned (health already set to error). */
    private spawnRunner(url: string, port: number): boolean {
        const runnerPath = resolveRunnerPath();
        if (!runnerPath) {
            this.setHealth(
                'error',
                'hls-pipe-runner.js not found — build the hls-player plugin (pnpm build)',
            );
            return false;
        }
        this.runner = this.spawnRunnerProcess({
            label: 'hls-pipe',
            command: process.execPath,
            args: [runnerPath],
            env: { HLS_CONFIG: JSON.stringify(this.buildRunnerConfig(url, port)) },
            autoRestart: true,
            clearBadges: ['bitrate'],
            onStdout: (line) => this.parseStats(line),
            onStderr: (line) => this.handleRunnerStderr(line),
        });
        // A clean exit means the runner ran out of playlist — the VOD window
        // ended. That is a natural end of playback, not a fault: stop the
        // module cleanly (no crash-restart, no respawn loop replaying the
        // asset with a multi-second gap). Deliberate teardown paths don't
        // reach here: module stop / URL relaunch destroy the process
        // (`destroyed`), crashes exit non-zero, kills carry a signal.
        const proc = this.runner;
        proc.on('stopped', (code: number | null, signal: string | null) => {
            if (proc.destroyed || !this.running || this.runner !== proc) return;
            if (code === 0 && signal === null) {
                this.requestSelfStop('Stream ended (playlist complete)');
            }
        });
        // `spawnRunnerProcess` wired the generic crash health ("hls-pipe
        // crashed — restarting (attempt N)") first, so it fires first and
        // would bury the reason the runner keeps dying. These listeners are
        // registered last and therefore win — a rejected origin stays on the
        // card, restart after restart.
        proc.on('restarting', () => this.reassertOriginFailure());
        proc.on('error', () => this.reassertOriginFailure());
        return true;
    }

    /**
     * Runner stderr: hls-pipe's own log plus the fatal `hls-pipe error:` line.
     * Ordinary chatter stays at info; a recognised origin failure is logged as
     * a warning (so it is findable in the journal) and, once it earns a
     * message, put on the module card by `noteOriginFailure`.
     */
    private handleRunnerStderr(line: string): void {
        if (this.noteOriginFailure(line)) this.log.warn({ src: 'hls-pipe' }, line);
        else this.log.info(line);
    }

    /**
     * Classify one failure text — a runner stderr line or a probe error — and,
     * when it is operator-actionable, latch it and show it on the module card.
     *
     * Latched rather than one-shot because the runner exits on these and comes
     * straight back: the message has to survive the restart churn, and only
     * bytes actually flowing again (`parseStats`) or a new URL retire it.
     *
     * @returns true when the text was recognised as an origin failure.
     */
    private noteOriginFailure(text: string): boolean {
        const failure = classifyOriginFailure(text);
        if (!failure) return false;
        if (failure.kind === 'fetch') this.fetchFailures += 1;
        const message = originFailureMessage(failure, this.fetchFailures);
        if (!message) return true; // a blip so far — logged, but not alarming
        this.originFailure = message;
        this.setHealth('error', message);
        return true;
    }

    /** Re-assert a latched origin failure over generic process health. */
    private reassertOriginFailure(): void {
        if (this.running && this.originFailure) this.setHealth('error', this.originFailure);
    }

    /** The origin is serving us again (or is a different origin entirely). */
    private clearOriginFailure(): void {
        this.originFailure = null;
        this.fetchFailures = 0;
    }

    /** Health for a launched runner: 'ok', unless the origin has already told
     *  us it won't serve this URL — a spawned but doomed runner isn't ok. */
    private setPlayingHealth(): void {
        if (this.originFailure) this.setHealth('error', this.originFailure);
        else this.setHealth('ok');
    }

    private buildRunnerConfig(url: string, port: number): Record<string, unknown> {
        // Effective ABR bitrate cap = the tightest of: the explicit capBitrate
        // One "Quality" dropdown drives everything: resolveQuality maps it to an
        // internal quality + resolution ceiling, which becomes a bitrate cap via
        // the probed variant ladder so the box never picks a variant it can't
        // decode. A legacy separate `maxHeight`/`capBitrate` (from before the
        // dropdown was unified) is still honoured as a fallback.
        const resolved = resolveQuality(String(this.config.quality ?? 'auto'));
        const maxHeight = resolved.maxHeight || Number(this.config.maxHeight ?? 0);
        const legacyCapKbps = Number(this.config.capBitrate ?? 0);
        const explicitBps = legacyCapKbps > 0 ? Math.round(legacyCapKbps * 1000) : 0;
        const resBps = resolutionCapBitrateBps(this.masterVariants, maxHeight);
        const caps = [explicitBps, resBps].filter((c) => c > 0);
        return {
            url,
            // Egress descriptor — the runner writes paced TS to the fan-out
            // sidecar's ingest socket.
            sink: { kind: 'unixfd', ingestPath: busIngestSocketPath(port) },
            quality: resolved.quality,
            capBitrateBps: caps.length ? Math.min(...caps) : 0,
            abrPreset: (this.config.abrPreset as string) ?? 'default',
            inlineAudio: asArray(this.config.audioLanguages),
            inlineSubtitles: asArray(this.config.subtitleLanguages),
            allowMonoAudio: !!this.config.allowMonoAudio,
            liveStartSegments: Number(this.config.liveStartSegments ?? 6),
            liveSyncSec: Number(this.config.liveSyncSec ?? 0),
            liveMaxLagSec: Number(this.config.liveMaxLagSec ?? 30),
            skipOnStall: !!this.config.skipOnStall,
        };
    }

    private async probe(url: string): Promise<void> {
        try {
            const { NodeLoader, parseMaster, isMasterPlaylist } = await import('hls-pipe');
            const res = await new NodeLoader().fetch({ url, kind: 'manifest' });
            const body = Buffer.from(res.body).toString('utf8');
            if (!isMasterPlaylist(body)) {
                this.playlistKind = 'Media';
                this.masterVariants = [];
                this.setFieldOptions('audio', []);
                this.setFieldOptions('subtitles', []);
                this.log.info('probe: media playlist (no alternate renditions)');
                return;
            }
            const master = parseMaster(body, url);
            // Keep the variant ladder (bitrate + resolution) so a maxHeight
            // ceiling can be translated to a bitrate cap at spawn time.
            this.masterVariants = master.variants.map((v) => ({
                bitrate: v.bitrate,
                ...(v.resolution ? { resolution: { height: v.resolution.height } } : {}),
            }));
            const audio = langOptions(master.audio);
            const subs = langOptions(master.subtitles);
            this.playlistKind = 'Master';
            this.setFieldOptions('audio', audio);
            this.setFieldOptions('subtitles', subs);
            this.log.info(
                {
                    audio: audio.map((o) => o.value),
                    subtitles: subs.map((o) => o.value),
                },
                'probe: detected languages',
            );
        } catch (err) {
            // A failed probe means we know nothing about this URL's renditions —
            // drop the previous stream's languages rather than showing stale options.
            this.playlistKind = '—';
            this.masterVariants = [];
            this.setFieldOptions('audio', []);
            this.setFieldOptions('subtitles', []);
            const msg = err instanceof Error ? err.message : String(err);
            // The probe fetches the master playlist with the same signed URL the
            // runner is about to use, so a 403 here is the earliest — and
            // clearest — evidence of an expired token: surface it now instead of
            // waiting out a crash-restart cycle to learn the same thing.
            this.noteOriginFailure(msg);
            this.log.warn({ err: msg }, 'HLS probe failed');
        }
    }

    private updateSourceStatus(): void {
        const audio = asArray(this.config.audioLanguages);
        const subs = asArray(this.config.subtitleLanguages);
        this.setStatusData('source', {
            playlist: this.playlistKind,
            quality: (this.config.quality as string) ?? 'auto',
            audio: audio.length ? audio.join(', ') : 'all',
            subtitles: subs.length ? subs.join(', ') : 'off',
        });
    }

    private parseStats(line: string): void {
        const i = line.indexOf('{');
        if (i < 0) return;
        try {
            const msg = JSON.parse(line.slice(i)) as {
                stats?: { bitrateMbps?: number; bytesSent?: number };
            };
            const s = msg.stats;
            if (!s) return;
            // Bytes on the wire are the only proof that fetching RECOVERED —
            // the runner being up says nothing (it restarts into the same 403,
            // and its 2 s stats timer fires whether or not a segment landed).
            if (typeof s.bytesSent === 'number' && s.bytesSent > 0) this.clearOriginFailure();
            // A stats line proves the runner is alive — clear the warning set
            // while it was crash-looping / restarting. A latched origin failure
            // outranks it.
            if (this.running && this.health !== 'ok' && !this.originFailure) this.setHealth('ok');
            this.setStatusData('stats', {
                bitrate: typeof s.bitrateMbps === 'number' ? s.bitrateMbps.toFixed(2) : '—',
                data: typeof s.bytesSent === 'number' ? formatBytes(s.bytesSent) : '—',
            });
            if (typeof s.bitrateMbps === 'number') {
                this.setBadge('bitrate', {
                    icon: 'activity',
                    text: `${s.bitrateMbps.toFixed(1)} Mbps`,
                    color: '#10b981',
                });
            }
        } catch {
            /* not a stats line */
        }
    }
}
