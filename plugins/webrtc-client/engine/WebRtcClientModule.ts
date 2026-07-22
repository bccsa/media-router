import http from 'node:http';
import { GstPluginBase, type PipelineDescription, type ModuleServices } from '@media-router/engine';

/** Internal-only bind — the config API must not be reachable from external devices. */
const HOST = '127.0.0.1';
const PORT = 2000;

/** One configured WebRTC (WHEP) audio stream, as edited in the module settings. */
interface WebRtcClient {
    name: string;
    description: string;
    url: string;
    countryCode: string;
}

/** The V1.3 `/config.json` document shape, consumed by media-router-audio-app. */
interface WebRtcClientConfig {
    displayName: string;
    webRtcAudioStreams: Array<{
        id: string;
        name: string;
        url: string;
        countryCode: string;
        note: string;
    }>;
}

/**
 * WebRTC (WHEP) client config publisher.
 *
 * Ports the V1.3 `WebRTCClient` control to V2: serves a JSON document describing
 * the available WebRTC audio streams on an internal-only HTTP endpoint
 * (`GET http://127.0.0.1:2000/config.json`). The media-router-audio-app project
 * fetches this to render WHEP players for web clients.
 *
 * Media Router is NOT a WebRTC server — each client just carries the WHEP URL of
 * an external server (e.g. MediaMTX).
 *
 * Pure service module: no GStreamer pipeline (`buildPipeline` → null), manages its
 * own lifecycle like `n1-mixer`. The fixed port also bounds it to a single instance:
 * if the port is already taken (a duplicate instance, or a foreign process) the
 * module reports health=error and stays stopped — it does not self-disable.
 */
export class WebRtcClientModule extends GstPluginBase {
    // Edits to the stream list / title apply live — the route reads `this.config`
    // at request time, so the base-class default onLiveConfigUpdate (merge) suffices.
    protected liveUpdatableParams: string[] = ['displayName', 'clients'];

    private server: http.Server | null = null;

    async onInit(config: Record<string, unknown>, services?: ModuleServices): Promise<void> {
        await super.onInit(config, services);
    }

    /** Pure service — no GStreamer pipeline. */
    buildPipeline(_config: Record<string, unknown>): PipelineDescription | null {
        return null;
    }

    /** No audio ports. */
    getPipeWireNodes(): { source?: string; sink?: string } {
        return {};
    }

    /**
     * Map the configured clients to the V1.3 `/config.json` shape. Field renames:
     * `description` → `note`; `countryCode` passes through. Ids are index-based.
     */
    private buildConfig(): WebRtcClientConfig {
        const clients = (this.config.clients as WebRtcClient[] | undefined) ?? [];
        return {
            displayName: (this.config.displayName as string) ?? 'Audio Streaming Service',
            webRtcAudioStreams: clients.map((c, i) => ({
                id: `client-${i}`,
                name: c?.name ?? '',
                url: c?.url ?? '',
                countryCode: c?.countryCode ?? '',
                note: c?.description ?? '',
            })),
        };
    }

    /**
     * Start the internal config API. Does NOT call super.onStart() — this module
     * runs an HTTP server instead of a GStreamer child process.
     */
    async onStart(): Promise<void> {
        const server = http.createServer((req, res) => {
            const path = (req.url ?? '').split('?')[0];
            // No keep-alive: this endpoint is polled occasionally, and closing the
            // socket per response avoids clients reusing a stale connection across
            // a module restart (same fixed port).
            if (req.method === 'GET' && path === '/config.json') {
                const body = JSON.stringify(this.buildConfig());
                res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
                res.end(body);
                return;
            }
            res.writeHead(404, { 'content-type': 'application/json', connection: 'close' });
            res.end(JSON.stringify({ error: 'Not found' }));
        });

        server.on('error', (err: NodeJS.ErrnoException) => {
            // Port already occupied — by a duplicate instance OR a foreign process.
            // Report an error and stay stopped; do NOT self-disable. A foreign
            // occupant must never permanently disable the module, and there is no
            // auto-retry — a manual restart re-attempts the bind.
            if (err.code === 'EADDRINUSE') {
                this.server = null; // never bound — keep onStop from closing it
                this.log.error({ port: PORT }, 'Port already in use — cannot start config API');
                this.setHealth(
                    'error',
                    `Port ${PORT} already in use — another process or WebRTC Client Config instance owns it`,
                );
                return;
            }
            this.log.error({ err }, 'WebRTC client config server error');
            this.setHealth('error', err.message);
        });

        this.server = server;

        // Settle on either successful bind or bind failure — on failure the
        // persistent 'error' handler above has already set health / self-stopped.
        const listening = await new Promise<boolean>((resolve) => {
            const onBindError = () => resolve(false);
            server.once('error', onBindError);
            server.listen(PORT, HOST, () => {
                server.removeListener('error', onBindError);
                resolve(true);
            });
        });

        if (!listening) return;

        this.running = true;
        this.health = 'ok';
        this.emit('stateChange', this.getState());
        this.refreshStatus();

        this.log.info({ host: HOST, port: PORT }, 'WebRTC client config API listening');
    }

    async onStop(): Promise<void> {
        if (this.server) {
            const server = this.server;
            this.server = null;
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
        await super.onStop();
    }

    async onLiveConfigUpdate(changes: Record<string, unknown>): Promise<void> {
        Object.assign(this.config, changes);
        this.refreshStatus();
    }

    private refreshStatus(): void {
        const clients = (this.config.clients as WebRtcClient[] | undefined) ?? [];
        this.setStatusData('service', {
            endpoint: `${HOST}:${PORT}/config.json`,
            streamCount: clients.length,
            status: 'Active',
        });
    }
}
