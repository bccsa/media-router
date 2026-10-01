import express from 'express';
import compression from 'compression';
import cors from 'cors';
import { createServer, type Server as HttpServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { createLogger, safeParse, PatchEnvelopeSchema } from '@media-router/shared-types';
import type { DgramListener, PatchOp } from '@media-router/shared-types';
import { ConfigStore } from './config/ConfigStore.js';
import { EngineConnectionManager } from './engines/EngineConnectionManager.js';
import { PluginRegistry } from './plugins/PluginRegistry.js';
import { TopicBus } from '@media-router/topic-tree';
import { EngineCommandService } from './handlers/EngineCommandService.js';
import { EngineEventForwarder } from './handlers/EngineEventForwarder.js';
import { PatchRouter, engineSenderId, routerKeepsInterlocks } from './PatchRouter.js';
import { registerHttpRoutes } from './routes/httpRoutes.js';
import { PluginUploadService } from './services/PluginUploadService.js';
import { RuntimeCache } from './tree/RuntimeCache.js';
import { EngineView } from './tree/EngineView.js';
import { ManagerTree } from './tree/ManagerTree.js';
import { TreePublisher } from './tree/TreePublisher.js';
import { TreeWrites } from './tree/TreeWrites.js';
import { AdminWrites } from './tree/AdminWrites.js';
import { TreeCalls } from './tree/TreeCalls.js';
import { ManagerScripts } from './tree/ManagerScripts.js';
import { setupTree } from './tree/setupTree.js';

const log = createLogger('Manager');

export interface ManagerConfig {
    httpPort?: number;
    /** Default UDP listener for engines when the operator has never saved one (issue #692). */
    dgramPort?: number;
    dbPath?: string;
}

/**
 * Central manager — stores engine configs, manages engine connections,
 * serves Web UI and proxies state between engines and browsers.
 *
 * Business logic:
 * - PatchRouter.ts                — unified N-1 config patch routing
 * - handlers/EngineCommandService — engine start/stop with retry
 * - handlers/EngineEventForwarder — engine events → runtime cache → tree
 * - tree/                         — the browser protocol (ADR-0024): tree
 *                                    source, publisher, write/call dispatch
 * - plugins/PluginRegistry.ts     — plugin manifest scanning
 * - routes/httpRoutes.ts          — /health + static SPA serving
 */
export class Manager {
    private readonly config: Required<ManagerConfig>;
    private readonly configStore: ConfigStore;
    private readonly engineManager: EngineConnectionManager;
    private readonly httpServer: HttpServer;
    private readonly io: SocketIOServer;
    private readonly pluginRegistry: PluginRegistry;
    private readonly engineCommands: EngineCommandService;
    private readonly scripts: ManagerScripts;
    private running = false;

    constructor(config: Partial<ManagerConfig> = {}) {
        this.config = { httpPort: 8080, dgramPort: 3000, ...config } as Required<ManagerConfig>;

        // Core services
        this.configStore = new ConfigStore(this.config.dbPath);
        // Listeners saved from the UI win over the entrypoint's default port:
        // the DB is what the operator edits and it rides along in /data.
        const listeners: DgramListener[] = this.configStore.getDgramListeners() ?? [
            { port: this.config.dgramPort },
        ];
        this.engineManager = new EngineConnectionManager(this.configStore, listeners);

        // HTTP + Socket.IO
        const app = express();
        app.use(compression());
        app.use(cors());
        app.use(express.json());
        this.httpServer = createServer(app);
        this.io = new SocketIOServer(this.httpServer, {
            cors: { origin: '*' },
            perMessageDeflate: true,
            // Default is 1 MB, which silently disconnects the socket on
            // anything bigger — including a `plugin:upload` for a chunky
            // image. Sized generously above the largest per-plugin upload
            // policy any plugin manifest declares, so we don't have to
            // bump this every time a new plugin opts into uploads.
            // Memory-bound: a single in-flight upload occupies this much
            // per client.
            maxHttpBufferSize: 200 * 1024 * 1024,
        });

        // Services
        this.pluginRegistry = new PluginRegistry();
        const pluginRegistry = this.pluginRegistry;
        const configStore = this.configStore;
        const engineManager = this.engineManager;
        this.engineCommands = new EngineCommandService(configStore, engineManager);
        const engineCommands = this.engineCommands;

        // The tree (ADR-0024): runtime cache + stored config → one subscribable view.
        const runtime = new RuntimeCache();
        const view = new EngineView({ configStore, runtime, pluginRegistry, engineManager });
        const tree = new ManagerTree({ view, configStore, engineManager, pluginRegistry });
        const bus = new TopicBus(tree);
        const publisher = new TreePublisher(bus, view);

        const eventForwarder = new EngineEventForwarder(
            configStore,
            engineManager,
            engineCommands,
            runtime,
            publisher,
        );
        const patchRouter = new PatchRouter(configStore, engineManager, publisher, pluginRegistry, runtime);
        engineManager.keepsInterlocks = (engineId) => routerKeepsInterlocks(runtime, engineId);
        eventForwarder.setup();

        // Handle patches from engine (N-1 router)
        engineManager.on('enginePatch', (engineId: string, data: unknown) => {
            const envelope = safeParse(PatchEnvelopeSchema, data, 'enginePatch', log);
            if (envelope) patchRouter.onPatch(engineSenderId(engineId), engineId, envelope.ops);
        });

        // Interlock repairs made on engine reconnect (id paths) reach every browser.
        engineManager.on('interlockRepair', (engineId: string, ops: PatchOp[]) => {
            publisher.config(engineId, ops.map((op) => ({ op, fromSender: false })), '');
        });

        const writes = new TreeWrites(
            patchRouter,
            view,
            new AdminWrites({ configStore, engineManager, engineCommands, runtime, publisher, tree }),
            bus,
        );
        const scripts = (this.scripts = new ManagerScripts({ tree, bus, configStore }));
        tree.runs = () => scripts.runs.tree();
        const calls = new TreeCalls({
            configStore,
            engineManager,
            runtime,
            publisher,
            patchRouter,
            pluginUploads: new PluginUploadService(pluginRegistry),
            scripts,
        });
        scripts.attach(writes, calls);
        setupTree({ io: this.io, bus, writes, calls });
        registerHttpRoutes({ app });

        log.info(
            { httpPort: this.config.httpPort, dgramListeners: this.engineManager.dgramListeners },
            'Manager configured',
        );
    }

    async start(): Promise<void> {
        if (this.running) return;
        await this.pluginRegistry.init();
        await this.engineManager.start();
        log.info({ listeners: this.engineManager.dgramListeners }, 'dgram-comms listening');

        await new Promise<void>((resolve) => {
            this.httpServer.listen(this.config.httpPort, () => {
                log.info({ port: this.config.httpPort }, 'HTTP + Socket.IO listening');
                resolve();
            });
        });
        this.running = true;
    }

    async stop(): Promise<void> {
        if (!this.running) return;
        this.running = false;
        this.engineCommands.cancelAll();
        // Button runs end with the server, as on a router (ADR-0027).
        this.scripts.runs.stopAll();
        await this.engineManager.stop();
        this.io.close();
        await new Promise<void>((resolve) => this.httpServer.close(() => resolve()));
        this.configStore.close();
    }

    /**
     * Alias for `stop()`. Deployed `start-manager.js` entrypoints (laid down
     * by the Yocto recipe) call `manager.shutdown()` from their SIGTERM/SIGINT
     * handlers — without this alias every restart logs a TypeError before
     * `process.exit(0)` runs and skips cleanup. Keep both names supported.
     */
    async shutdown(): Promise<void> {
        await this.stop();
    }
}
