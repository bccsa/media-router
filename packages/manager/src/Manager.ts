import express from 'express';
import compression from 'compression';
import cors from 'cors';
import { createServer, type Server as HttpServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { createLogger, safeParse, PatchEnvelopeSchema } from '@media-router/shared-types';
import { ConfigStore } from './config/ConfigStore.js';
import { EngineConnectionManager } from './engines/EngineConnectionManager.js';
import { PluginRegistry } from './plugins/PluginRegistry.js';
import { EngineCommandService } from './handlers/EngineCommandService.js';
import { EngineEventForwarder } from './handlers/EngineEventForwarder.js';
import { PatchRouter } from './PatchRouter.js';
import { setupSocketIO } from './socket/SocketIOSetup.js';
import { registerHttpRoutes } from './routes/httpRoutes.js';

const log = createLogger('Manager');

export interface ManagerConfig {
    httpPort?: number;
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
 * - handlers/EngineEventForwarder — engine→browser event streaming
 * - plugins/PluginRegistry.ts     — plugin manifest scanning
 * - routes/httpRoutes.ts          — REST API endpoints
 */
export class Manager {
    private readonly config: Required<ManagerConfig>;
    private readonly configStore: ConfigStore;
    private readonly engineManager: EngineConnectionManager;
    private readonly httpServer: HttpServer;
    private readonly io: SocketIOServer;
    private readonly pluginRegistry: PluginRegistry;
    private readonly engineCommands: EngineCommandService;
    private running = false;

    constructor(config: Partial<ManagerConfig> = {}) {
        this.config = { httpPort: 8080, dgramPort: 3000, ...config } as Required<ManagerConfig>;

        // Core services
        this.configStore = new ConfigStore(this.config.dbPath);
        this.engineManager = new EngineConnectionManager(this.configStore, this.config.dgramPort);

        // HTTP + Socket.IO
        const app = express();
        app.use(compression());
        app.use(cors());
        app.use(express.json());
        this.httpServer = createServer(app);
        this.io = new SocketIOServer(this.httpServer, {
            cors: { origin: '*' },
            perMessageDeflate: true,
        });

        // Services
        this.pluginRegistry = new PluginRegistry();
        const pluginRegistry = this.pluginRegistry;
        this.engineCommands = new EngineCommandService(this.configStore, this.engineManager);
        const engineCommands = this.engineCommands;
        const eventForwarder = new EngineEventForwarder(this.configStore, this.engineManager, engineCommands, this.io);
        const patchRouter = new PatchRouter(this.configStore, this.engineManager, this.io, pluginRegistry);

        // Wire everything
        eventForwarder.setup();

        // Handle patches from engine (N-1 router)
        this.engineManager.on('enginePatch', (engineId: string, data: unknown) => {
            const envelope = safeParse(PatchEnvelopeSchema, data, 'enginePatch', log);
            if (envelope) patchRouter.onPatch('engine', 'engine', engineId, envelope.ops);
        });

        setupSocketIO({ io: this.io, configStore: this.configStore, engineManager: this.engineManager, pluginRegistry, engineCommands, eventForwarder, patchRouter });
        registerHttpRoutes({ app, configStore: this.configStore, engineManager: this.engineManager, pluginRegistry, io: this.io, eventForwarder });

        log.info({ httpPort: this.config.httpPort, dgramPort: this.config.dgramPort }, 'Manager configured');
    }

    async start(): Promise<void> {
        if (this.running) return;
        await this.pluginRegistry.init();
        await this.engineManager.start();
        log.info({ port: this.config.dgramPort }, 'dgram-comms listening');

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
        await this.engineManager.stop();
        this.io.close();
        await new Promise<void>((resolve) => this.httpServer.close(() => resolve()));
        this.configStore.close();
    }
}
