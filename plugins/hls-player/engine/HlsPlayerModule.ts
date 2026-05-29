import { GstPluginBase, formatBytes, type PipelineDescription } from '@media-router/engine';
import type { ManagedProcess } from '@media-router/engine';
import type { AlternateRendition } from 'hls-pipe';
import { join } from 'node:path';

const MULTICAST_HOST = '239.255.0.1';
const RUNNER_PATH = join(__dirname, 'hls-pipe-runner.js');

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
 * child by `hls-pipe-runner.ts`) and re-broadcasts canonical MPEG-TS on local
 * UDP multicast for downstream modules — same producer contract as srt-input.
 *
 * On start it probes the master playlist to detect available audio / subtitle
 * languages and reports them as `fieldOptions`, so the settings panel can show
 * language selectors populated from the actual stream. URL changes apply live
 * (re-probe + relaunch the runner); language / quality changes need a module
 * restart — see `getLiveUpdatableParams()`.
 */
export class HlsPlayerModule extends GstPluginBase {
    private runner: ManagedProcess | null = null;
    private playlistKind = '—';

    async onStart(): Promise<void> {
        this.log.info(
            {
                hasMediaRouter: !!this.services?.mediaRouter,
                hasProcessManager: !!this.services?.processManager,
            },
            'onStart',
        );
        if (!this.services?.mediaRouter) {
            this.setHealth('error', 'mediaRouter service unavailable');
            return;
        }

        // Reserve the UDP egress port up front (same as encoders) so a URL
        // pasted later — applied live — can launch the runner without a restart.
        // Only `mediaRouter` is required for this; `processManager` is checked
        // later, when we actually need to spawn the runner.
        this.services.mediaRouter.assignUdpPort(this.services.instanceId);
        const endpoint = this.services.mediaRouter.getUdpEndpoint(this.services.instanceId);
        if (!endpoint) {
            this.setHealth('error', 'No UDP port assigned — cannot output MPEG-TS');
            return;
        }
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
        this.spawnRunner(url, endpoint.port);
        this.setHealth('ok');
        this.updateSourceStatus();
        // No GStreamer pipeline — the runner handles HLS → UDP.
    }

    async onStop(): Promise<void> {
        // ProcessManager auto-kills the runner on module stop; just drop the ref.
        this.runner = null;
        await super.onStop();
    }

    buildPipeline(): PipelineDescription | null {
        return null;
    }

    /**
     * Only URL applies live (re-probes and relaunches the runner). Language
     * selections need a module restart — `onLiveConfigUpdate` wouldn't relaunch
     * mid-stream cleanly for them, and the pending-restart UX is fine there.
     */
    getLiveUpdatableParams(): string[] {
        return ['url'];
    }

    async onLiveConfigUpdate(changes: Record<string, unknown>): Promise<void> {
        // Snapshot the URL *before* merging so we can tell whether it actually
        // changed. Without this, every config push with `url` present (even
        // unchanged) would re-probe and relaunch the runner — the manager
        // re-syncs config on its own schedule, and a respawn loop ensues.
        const prevUrl = String(this.config.url ?? '').trim();
        await super.onLiveConfigUpdate(changes); // merges into this.config
        const url = String(this.config.url ?? '').trim();
        const urlChanged = 'url' in changes && url !== prevUrl;

        if (urlChanged && url) await this.probe(url);

        // Only relaunch on a real URL change. Other live params don't reach us
        // (`getLiveUpdatableParams` returns just `['url']`), but be explicit.
        if (!urlChanged) return;
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
        if (!url) return;
        this.services.mediaRouter.assignUdpPort(this.services.instanceId); // idempotent
        const endpoint = this.services.mediaRouter.getUdpEndpoint(this.services.instanceId);
        if (!endpoint) return;

        if (this.runner) {
            await this.services.processManager.kill(this.services.instanceId, this.runner);
            this.runner = null;
        }
        this.spawnRunner(url, endpoint.port);
        this.setHealth('ok');
        this.updateSourceStatus();
    }

    private spawnRunner(url: string, port: number): void {
        const services = this.services!;
        this.runner = services.processManager.spawn(services.instanceId, {
            label: 'hls-pipe',
            command: process.execPath,
            args: [RUNNER_PATH],
            env: { HLS_CONFIG: JSON.stringify(this.buildRunnerConfig(url, port)) },
            autoRestart: true,
            onStdout: (line) => this.parseStats(line),
            onStderr: (line) => this.log.info(line),
        });
        this.runner.on('error', (msg: string) => this.setHealth('error', msg));
    }

    private buildRunnerConfig(url: string, port: number): Record<string, unknown> {
        const capKbps = Number(this.config.capBitrate ?? 0);
        return {
            url,
            host: MULTICAST_HOST,
            port,
            quality: (this.config.quality as string) ?? 'auto',
            capBitrateBps: capKbps > 0 ? Math.round(capKbps * 1000) : 0,
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
                this.setFieldOptions('audio', []);
                this.setFieldOptions('subtitles', []);
                this.log.info('probe: media playlist (no alternate renditions)');
                return;
            }
            const master = parseMaster(body, url);
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
            this.log.warn({ err: err instanceof Error ? err.message : err }, 'HLS probe failed');
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
