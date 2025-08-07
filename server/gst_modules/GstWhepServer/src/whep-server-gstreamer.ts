import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import Gst from "@girs/node-gst-1.0";
import path from "path";
import {
    gstSetIceCandidate,
    filterSdp,
    creatBasePipeline,
    createWhepBin,
    WhepBin,
    startBin,
    stopBin,
    createSdpAnswer,
    getElementByName,
} from "./util";
import GObject from "@girs/node-gobject-2.0";
import GstWebRTC from "@girs/node-gstwebrtc-1.0";

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
            this.setupBusWatch();
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
            const sessionList = Array.from(this.sessions.entries()).map(
                ([id, session]) => ({
                    id,
                    state: session.state,
                    createdAt: session.createdAt,
                })
            );
            res.json({
                sessionCount: sessionList.length,
                sessions: sessionList,
            });
        });

        // WHEP endpoint - create new session
        this.app.post("/whep", async (req, res) => {
            try {
                console.log("📥 Received WHEP request");

                if (req.headers["content-type"] !== "application/sdp") {
                    return res.status(400).json({
                        error: "Content-Type must be application/sdp",
                    });
                }

                const sdpOffer = filterSdp(req.body);
                if (!sdpOffer || typeof sdpOffer !== "string") {
                    return res.status(400).json({ error: "Invalid SDP offer" });
                }

                console.log("📄 SDP Offer received, creating session...");
                const session = await this.createSession(sdpOffer);

                if (!session) {
                    return res
                        .status(500)
                        .json({ error: "Failed to create session" });
                }

                // Generate SDP answer
                const sdpAnswer = await this.generateAnswer(session);
                if (!sdpAnswer) {
                    this.cleanupSession(session.id);
                    return res
                        .status(500)
                        .json({ error: "Failed to generate SDP answer" });
                }

                res.status(201)
                    .header("Content-Type", "application/sdp")
                    .header("Location", `/whep/${session.id}`)
                    .send(sdpAnswer);

                console.log(`✅ Session ${session.id} created successfully`);
            } catch (error) {
                console.error("❌ Error handling WHEP request:", error);
                res.status(500).json({ error: "Internal server error" });
            }
        });

        // Get session info
        this.app.get("/whep/:sessionId", (req, res) => {
            const session = this.sessions.get(req.params.sessionId);
            if (!session) {
                return res.status(404).json({ error: "Session not found" });
            }

            res.json({
                id: session.id,
                state: session.state,
                createdAt: session.createdAt,
            });
        });

        // Delete session
        this.app.delete("/whep/:sessionId", (req, res) => {
            const sessionId = req.params.sessionId;
            const session = this.sessions.get(sessionId);

            if (!session) {
                return res.status(404).json({ error: "Session not found" });
            }

            this.cleanupSession(sessionId);
            res.status(204).send();
            console.log(`🗑️ Session ${sessionId} deleted`);
        });

        // Handle ICE candidates (PATCH)
        this.app.patch("/whep/:sessionId", (req, res) => {
            const session = this.sessions.get(req.params.sessionId);
            if (!session) {
                return res.status(404).json({ error: "Session not found" });
            }

            // Handle ICE candidate
            // TODO: This is untested, and in the testing environment is seems as if the client does not send the ICE candidates (RTCPeerConnection.onicecandidate is not triggered in the browser).
            if (
                req.headers["content-type"] ===
                "application/trickle-ice-sdpfrag"
            ) {
                console.log("🧊 Received ICE candidate");

                gstSetIceCandidate(session.whepBin.webrtc, 0, req.body);
                res.status(204).send();
            } else {
                res.status(400).json({ error: "Unsupported content type" });
            }
        });
    }

    private async createSession(sdpOffer: string): Promise<WHEPSession | null> {
        try {
            const sessionId = uuidv4();
            console.log(
                `🔧 Creating GStreamer pipeline for session ${sessionId}`
            );

            // link elements to the base pipeline
            const whepBin = createWhepBin(this.basePipeline, sessionId);
            if (!whepBin) {
                console.error("❌ Failed to create whepBin");
                return null;
            }

            const webrtc = whepBin.webrtc;
            if (!webrtc) {
                console.error("❌ WebRTC element not found in WHEP bin");
                return null;
            }

            const session: WHEPSession = {
                id: sessionId,
                whepBin: whepBin,
                createdAt: new Date(),
                state: "connecting",
                sdpOffer: sdpOffer,
            };

            // Setup WebRTC signals
            this.setupWebRTCSignals(session);

            this.sessions.set(sessionId, session);
            console.log(`✅ Session ${sessionId} created`);

            return session;
        } catch (error) {
            console.error("❌ Error creating session:", error);
            return null;
        }
    }

    private setupWebRTCSignals(session: WHEPSession): void {
        try {
            // Handle connection state changes
            session.whepBin.webrtc.connect("notify::connection-state", () => {
                try {
                    const state = (
                        session.whepBin.webrtc.getProperty(
                            "connection-state"
                        ) as GObject.Value
                    ).getBoxed();

                    // Update session state based on WebRTC state
                    if (
                        state === GstWebRTC.WebRTCPeerConnectionState.CONNECTED
                    ) {
                        session.state = "connected";
                        console.log(
                            `✅ Session ${session.id} - Client connected and receiving audio`
                        );
                    } else if (
                        state === GstWebRTC.WebRTCPeerConnectionState.FAILED ||
                        state === GstWebRTC.WebRTCPeerConnectionState.CLOSED
                    ) {
                        session.state = "failed";
                        console.log(
                            `❌ Session ${session.id} - Connection failed/closed`
                        );
                        setTimeout(() => this.cleanupSession(session.id), 5000);
                    }
                } catch (error) {
                    console.log(
                        `⚠️ Error handling connection state for session ${session.id}:`,
                        error
                    );
                }
            });

            // watch for RTP Timeout (If RTP session times out, we will cleanup the session)
            const rtpbin = getElementByName(
                session.whepBin.webrtc as Gst.Bin,
                "rtpbin",
                false
            );

            if (rtpbin) {
                rtpbin.connect("on-timeout", () => {
                    console.log(`⏰ RTP timeout for session: ${session.id}`);
                    // cleanup session
                    setTimeout(() => this.cleanupSession(session.id), 5000);
                });
            } else {
                console.log(
                    `⚠️ RTPBin not found in WebRTC element for session ${session.id}`
                );
            }
        } catch (e) {
            console.log(
                "⚠️ Could not connect connection state signals:",
                (e as Error).message
            );
        }
    }

    private setupBusWatch(basePipelineRunning: boolean = true): void {
        if (!this.basePipeline) return;
        const bus = this.basePipeline.getBus();
        if (!bus) return;

        const msg = bus.pop();
        if (msg) {
            switch (msg.type) {
                case Gst.MessageType.ERROR:
                    const [error, debug] = msg.parseError();
                    console.error(
                        `❌ Error message in base pipeline: ${error.message}`
                    );
                    if (debug) console.error(`🐛 Debug: ${debug}`);
                    break;

                case Gst.MessageType.EOS:
                    console.log(`🔚 Base pipeline- End of stream`);
                    // Cleanup all sessions
                    for (const [sessionId] of this.sessions) {
                        this.cleanupSession(sessionId);
                    }
                    break;

                case Gst.MessageType.STATE_CHANGED:
                    const [oldState, newState, pending] =
                        msg.parseStateChanged();
                    if (msg.src === this.basePipeline) {
                        console.log(
                            `🔄 Base pipeline state changed: ${Gst.Element.stateGetName(
                                oldState
                            )} -> ${Gst.Element.stateGetName(newState)}`
                        );
                    }
                    break;
            }
        }

        if (basePipelineRunning)
            setTimeout(() => {
                this.setupBusWatch();
            }, 100);
    }

    private async generateAnswer(session: WHEPSession): Promise<string | null> {
        try {
            console.log(`📝 Generating SDP answer for session ${session.id}`);

            // Use a promise-based approach since the GStreamer bindings have limitations
            return new Promise<string>(async (resolve, reject) => {
                // Start the pipeline first
                console.log(`🚀 Starting webrtcBin for session: ${session.id}`);
                const ret = startBin(session.whepBin);
                if (!ret) {
                    reject(new Error("Failed to start webrtc element"));
                    return;
                }

                const sdpAnswer = await createSdpAnswer(session, this.settings);

                if (!sdpAnswer) {
                    console.error("❌ Failed to create SDP answer");
                    reject(new Error("Failed to create SDP answer"));
                    return;
                }

                resolve(sdpAnswer);
            });
        } catch (error) {
            console.error("❌ Error generating answer:", error);
            return null;
        }
    }

    private cleanupSession(sessionId: string): void {
        const session = this.sessions.get(sessionId);
        if (!session) return;

        try {
            console.log(`🧹 Cleaning up session ${sessionId}`);
            session.state = "closed";
            if (session.whepBin) stopBin(session.whepBin);
            this.sessions.delete(sessionId);
        } catch (error) {
            console.error(`❌ Error cleaning up session ${sessionId}:`, error);
        }
    }

    public start(port: number = 9090): void {
        this.app.listen(port, () => {
            console.log("🚀 WHEP GStreamer Server started");
            console.log("=====================================");
            console.log(`📡 Server running on port ${port}`);
            this.settings.enableTestClient &&
                console.log(`📋 Local test client: http://localhost:${port}`);
            console.log(`📋 Sessions list: http://localhost:${port}/sessions`);
            console.log(`🎶 WHEP endpoint: http://localhost:${port}/whep`);
            console.log("");
            console.log("Ready to serve audio to WHEP clients...");
            console.log("Connect with any WHEP-compatible client!");
        });
    }

    public stop(): void {
        console.log("🛑 Shutting down WHEP server...");

        // Cleanup all sessions
        for (const [sessionId] of this.sessions) {
            this.cleanupSession(sessionId);
        }

        console.log("✅ Server stopped");
        process.exit(0);
    }
}
