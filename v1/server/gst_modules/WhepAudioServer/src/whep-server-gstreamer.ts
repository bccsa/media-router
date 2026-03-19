import express from "express";
import cors from "cors";
import Gst from "@girs/node-gst-1.0";
import path from "path";
import {
    creatBasePipeline,
    WhepBin,
    getSessions,
    getSessionsStats,
    getSession,
    cleanupSession,
    setupBusWatch,
    createWhepSession,
    whepPatchIce,
    deleteWhepSession,
    log,
} from "./util";

// Initialize GStreamer//
Gst.init([]);

export interface WHEPSession {
    id: string;
    whepBin: WhepBin;
    createdAt: Date;
    state: "connecting" | "connected" | "failed" | "closed";
    sdpOffer?: string; // Store SDP offer for later processing
}

export type WhepServerSettings = {
    pulseDevice: string; // PulseAudio source device
    port?: number; // Port for the WHEP server
    opusFec?: boolean; // Enable Opus FEC
    opusFecPacketLoss?: number; // Opus FEC packet loss percentage
    opusComplexity?: number; // Opus complexity (0-10)
    opusBitrate?: number; // Opus bitrate in bps
    opusFrameSize?: number; // Opus frame size in ms
    rtpRed?: boolean; // Enable RTP RED
    rtpRedDistance?: number; // RTP RED distance
    enableTestClient?: boolean; // Enable test client
};

export class WHEPGStreamerServer {
    private app: express.Application;
    private sessions: Map<string, WHEPSession> = new Map();
    private settings: WhepServerSettings;
    private basePipeline: Gst.Pipeline | null = null;

    constructor(settings: WhepServerSettings) {
        this.settings = settings;
        this.app = express();
        this.basePipeline = creatBasePipeline(settings);
        if (this.basePipeline) {
            setupBusWatch(this.sessions, this.basePipeline);
            this.setupMiddleware();
            this.setupRoutes();
        }
    }

    private setupMiddleware(): void {
        this.app.use(
            cors({
                origin: "*",
                methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
                allowedHeaders: ["Content-Type", "Authorization", "If-Match"],
            })
        );

        this.app.use(express.text({ type: "application/sdp" }));
        this.app.use(express.json());

        // Serve static files from public directory
        this.app.use(express.static(path.join(__dirname, "../public")));
    }

    private setupRoutes(): void {
        if (this.settings.enableTestClient)
            // Root route - serve client page
            this.app.get("/", (req, res) => {
                res.sendFile(
                    path.join(__dirname, "../public/whep-client.html")
                );
            });

        // List active sessions
        this.app.get("/sessions", (req, res) => {
            res.json(getSessions(this.sessions));
        });

        // List stats of active sessions
        this.app.get("/sessions/stats/:type", (req, res) => {
            res.json(getSessionsStats(this.sessions, req));
        });

        // WHEP endpoint - create new session
        this.app.post("/whep", async (req, res) => {
            if (req.headers["content-type"] !== "application/sdp") {
                return res.status(400).json({
                    error: "Content-Type must be application/sdp",
                });
            }

            const _r = await createWhepSession(
                req.body,
                this.sessions,
                this.basePipeline,
                this.settings
            );

            if (_r.error)
                return res.status(_r.status || 500).json({ error: _r.error });

            res.status(201)
                .header("Content-Type", "application/sdp")
                .header("Location", `/whep/${_r.sessionId}`)
                .send(_r.sdpAnswer);
        });

        // Get session info
        this.app.get("/whep/:sessionId", (req, res) => {
            res.json(getSession(this.sessions, req.params.sessionId));
        });

        // Delete session
        this.app.delete("/whep/:sessionId", (req, res) => {
            const sessionId = req.params.sessionId;
            const _r = deleteWhepSession(
                this.sessions,
                sessionId,
                this.basePipeline
            );

            if (_r.error)
                return res.status(_r.status).json({ error: _r.error });

            res.status(204).send();
        });

        // Handle ICE candidates (PATCH)
        this.app.patch("/whep/:sessionId", (req, res) => {
            const _r = whepPatchIce(this.sessions, req);

            if (_r.error) res.status(_r.status).json({ error: _r.error });

            res.status(_r.status).send();
        });
    }

    public start(port: number = 9090): void {
        this.app.listen(port, () => {
            log.info(`📡 Server running on port ${port}`);
            this.settings.enableTestClient &&
                log.info(`📋 Local test client: http://localhost:${port}`);
            log.info(`📋 Sessions list: http://localhost:${port}/sessions`);
            log.info(`🎶 WHEP endpoint: http://localhost:${port}/whep`);
        });
    }

    public stop(): void {
        log.info("🛑 Shutting down WHEP server...");

        // Cleanup all sessions
        for (const [sessionId] of this.sessions) {
            cleanupSession(sessionId, this.sessions, this.basePipeline);
        }

        log.info("✅ Server stopped");
        process.exit(0);
    }
}
