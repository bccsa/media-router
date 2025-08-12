import Gst from "@girs/node-gst-1.0";
import { WHEPSession } from "../whep-server-gstreamer";
import {
    whepBinStats,
    stopBin,
    createWhepBin,
    getWebrtcBinStats,
    setupWebRTCSignals,
} from "./";
import { v4 as uuidv4 } from "uuid";

/**
 * Return a list of active sessions
 * @param sessions - Map of session ID to WHEPSession
 * @returns
 */
export function getSessions(sessions: Map<string, WHEPSession>): any {
    const sessionList = Array.from(sessions.entries()).map(([id, session]) => ({
        id,
        state: session.state,
        createdAt: session.createdAt,
    }));
    return {
        sessionCount: sessionList.length,
        sessions: sessionList,
    };
}

/**
 * Get a single session by ID
 * @param sessions - Map of session ID to WHEPSession
 * @param req
 * @returns
 */
export function getSession(
    sessions: Map<string, WHEPSession>,
    sessionId: string
): any {
    const session = sessions.get(sessionId);

    if (!session) {
        return {
            error: `Session with ID ${sessionId} not found.`,
        };
    }

    return {
        id: sessionId,
        state: session.state,
        createdAt: session.createdAt,
        stats: session.whepBin.stats || null,
    };
}

/**
 * Get statistics for all sessions or a specific type of statistic
 * @param sessions - Map of session ID to WHEPSession
 * @param req - Request object containing the type of statistic and optional count
 * @returns
 */
export function getSessionsStats(
    sessions: Map<string, WHEPSession>,
    req: any
): any {
    const reqParam: string = req.params.type;
    const count = req.query.count;

    if (
        reqParam !== "rtt" &&
        reqParam !== "packetsLost" &&
        reqParam !== "packetsLostPercent" &&
        reqParam !== "packetSent" &&
        reqParam !== "sessionCount"
    ) {
        return {
            error: "Invalid request parameter. Use 'rtt', 'packetsLost', 'packetsLostPercent' or 'packetSent'.",
        };
    }

    if (reqParam === "sessionCount") {
        return {
            sessionCount: sessions.size,
        };
    }

    const res = Array.from(sessions.entries())
        .map(([id, session]) => {
            if (!session.whepBin.stats) return null;
            const sessionStats: whepBinStats = session.whepBin.stats;
            return sessionStats ? sessionStats[reqParam] : null;
        })
        .filter((value) => value !== null && !Number.isNaN(value));

    res.sort((a, b) => {
        if (typeof a === "number" && typeof b === "number") {
            return b - a; // Sort in descending order
        }
        return 0; // Return 0 for non-numeric comparisons
    });

    if (count) {
        const limit = parseInt(count, 10);
        if (isNaN(limit) || limit <= 0) {
            return {
                error: "Invalid count parameter. It must be a positive integer.",
            };
        }
        // Sample the response array to get evenly distributed entries
        if (limit >= res.length) {
            return res;
        }

        const sampledRes = [];
        const step = (res.length - 1) / (limit - 1);

        for (let i = 0; i < limit; i++) {
            const index = Math.round(i * step);
            sampledRes.push(res[index]);
        }

        return sampledRes;
    }

    return res;
}

export async function createSession(
    sdpOffer: string,
    sessions: Map<string, WHEPSession>,
    basePipeline: Gst.Pipeline | null
): Promise<WHEPSession | null> {
    try {
        const sessionId = uuidv4();
        console.log(`🔧 Creating GStreamer pipeline for session ${sessionId}`);

        // link elements to the base pipeline
        const whepBin = createWhepBin(basePipeline, sessionId);
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
        setupWebRTCSignals(session, sessions, basePipeline);

        // setup webrtc stats (Every 10 seconds)
        whepBin.statsIntervalId = setInterval(() => {
            const stats = getWebrtcBinStats(whepBin);
            if (stats) {
                whepBin.stats = stats;

                // if webrtc bin does not return stats for the client for more that 6 cycles, consider the client is disconnected
                if (stats.missingInbound >= 6)
                    cleanupSession(sessionId, sessions, basePipeline);
            }
        }, 10000);

        sessions.set(sessionId, session);
        console.log(`✅ Session ${sessionId} created`);

        return session;
    } catch (error) {
        console.error("❌ Error creating session:", error);
        return null;
    }
}

/**
 * Cleans up a session by stopping the WHEP bin and removing it from the sessions map.
 * @param id - The session ID to clean up.
 * @param sessions - Map of session ID to WHEPSession.
 * @param basePipeline - The base GStreamer pipeline.
 * @returns
 */
export function cleanupSession(
    id: string,
    sessions: Map<string, WHEPSession>,
    basePipeline: Gst.Pipeline | null
): void {
    const session = sessions.get(id);
    if (!session) return;

    try {
        console.log(`🧹 Cleaning up session ${id}`);
        session.state = "closed";
        // stop whepBin stats interval
        if (session.whepBin.statsIntervalId)
            clearInterval(session.whepBin.statsIntervalId);
        if (session.whepBin) stopBin(basePipeline, session.whepBin);
        sessions.delete(id);
    } catch (error) {
        console.error(`❌ Error cleaning up session ${id}:`, error);
    }
}
