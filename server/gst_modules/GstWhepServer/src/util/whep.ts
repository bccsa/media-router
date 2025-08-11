import {
    filterSdp,
    createSession,
    generateAnswer,
    cleanupSession,
    gstSetIceCandidate,
} from "./";
import { WHEPSession, WhepServerSettings } from "../whep-server-gstreamer";
import Gst from "@girs/node-gst-1.0";

/**
 * Create a new WHEP session based on the SDP offer received in the request body.
 * @param body - The SDP offer received in the WHEP request body
 * @param sessions - Map of session ID to WHEPSession
 * @param basePipeline - The base GStreamer pipeline to use for the session
 * @param settings - The WHEP server settings
 * @returns - A promise that resolves to an object containing the session ID and SDP answer, or an error
 */
export async function createWhepSession(
    body: string,
    sessions: Map<string, WHEPSession>,
    basePipeline: Gst.Pipeline | null,
    settings: WhepServerSettings
): Promise<{
    error?: string;
    status?: number;
    sdpAnswer?: string;
    sessionId?: string;
}> {
    try {
        console.log("📥 Received WHEP request");

        const sdpOffer = filterSdp(body);
        if (!sdpOffer || typeof sdpOffer !== "string") {
            return { error: "Invalid SDP offer", status: 400 };
        }

        console.log("📄 SDP Offer received, creating session...");
        const session = await createSession(sdpOffer, sessions, basePipeline);

        if (!session) {
            return { error: "Failed to create session", status: 500 };
        }

        // Generate SDP answer
        const sdpAnswer = await generateAnswer(session, settings);
        if (!sdpAnswer) {
            cleanupSession(session.id, sessions, basePipeline);
            return { error: "Failed to generate SDP answer", status: 500 };
        }

        console.log(`✅ Session ${session.id} created successfully`);

        return { sdpAnswer: sdpAnswer, sessionId: session.id };
    } catch (error) {
        console.error("❌ Error handling WHEP request:", error);
        return { error: "Internal server error", status: 500 };
    }
}

/**
 * Handle ICE candidate updates for a WHEP session.
 * @param sessions - Map of session ID to WHEPSession
 * @param req
 * @returns
 */
export function whepPatchIce(
    sessions: Map<string, WHEPSession>,
    req: any
): { error?: string; status: number } {
    const sessionId: string = req.params.sessionId;
    const session = sessions.get(sessionId);
    if (!session) {
        return { error: "Session not found", status: 400 };
    }

    // Handle ICE candidate
    // TODO: This is untested, and in the testing environment is seems as if the client does not send the ICE candidates (RTCPeerConnection.onicecandidate is not triggered in the browser).
    if (req.headers["content-type"] === "application/trickle-ice-sdpfrag") {
        console.log("🧊 Received ICE candidate");

        gstSetIceCandidate(session.whepBin.webrtc, 0, req.body);
        return { status: 204 };
    } else {
        return { error: "Unsupported content type", status: 400 };
    }
}

/**
 * deleteWhepSession - Deletes a WHEP session by its ID.
 * @param sessions - Map of session ID to WHEPSession
 * @param sessionId - The session ID to delete
 * @param basePipeline - The base GStreamer pipeline
 * @returns - { error?: string; status: number }
 */
export function deleteWhepSession(
    sessions: Map<string, WHEPSession>,
    sessionId: string,
    basePipeline: Gst.Pipeline | null
): { error?: string; status: number } {
    const session = sessions.get(sessionId);

    if (!session) {
        return { error: "Session not found", status: 404 };
    }

    cleanupSession(sessionId, sessions, basePipeline);
    return { status: 204 };
}
