import { WhepServerSettings, WHEPSession } from "../whep-server-gstreamer";
import Gst from "@girs/node-gst-1.0";
import GstWebRTC from "@girs/node-gstwebrtc-1.0";
import GObject from "@girs/node-gobject-2.0";
import os from "os";
import { getElementByName, whepBinStats, cleanupSession, log } from "./";

export type WhepBin = {
    // Client-specific processing
    capsfilter: Gst.Element;
    webrtc: Gst.Element;
    // Connection to selected per-core tee branch
    teeSrcpad: Gst.Pad;
    tee: Gst.Element; // The per-core tee this client is attached to
    branchIndex: number; // Index in the per-core pool for load tracking
    stats?: whepBinStats;
    statsIntervalId?: NodeJS.Timeout;
};

// Internal: per-core branch pool
type Branch = {
    index: number;
    mainTeePad: Gst.Pad; // pad requested from main tee feeding this branch
    queue: Gst.Element; // shared queue per branch
    tee: Gst.Element; // shared tee per branch to fan-out to clients
    clients: number; // number of clients attached
};

let mainTee: Gst.Element | null = null;
let branchPool: Branch[] = [];

function initBranchPool(basePipeline: Gst.Pipeline, cores: number) {
    mainTee = basePipeline.getByName("tee");
    if (!mainTee) throw new Error("Tee element not found in base pipeline");

    // Create N branches: main tee -> [queue_i] -> [tee_i] -> fakesink (keep flowing)
    for (let i = 0; i < cores; i++) {
        const srcPad = mainTee.getRequestPad("src_%u");
        if (!srcPad) throw new Error("Failed to request src pad from main tee");

        const q = Gst.ElementFactory.make("queue", `core-queue-${i}`);
        const subTee = Gst.ElementFactory.make("tee", `core-tee-${i}`);
        const fake = Gst.ElementFactory.make("fakesink", `core-fakesink-${i}`);
        if (!q || !subTee || !fake)
            throw new Error("Failed to create branch elements");

        // Configure queue to be protective and low-latency
        try {
            (q as any).setProperty?.("leaky", 2); // downstream
            (q as any).setProperty?.("max-size-buffers", 0);
            (q as any).setProperty?.("max-size-bytes", 0);
            (q as any).setProperty?.("max-size-time", 20000000); // 20ms
        } catch (e) {
            log.error("❌ Failed to set branch queue properties: " + e);
        }

        try {
            (fake as any).setProperty?.("sync", false);
            (fake as any).setProperty?.("async", false);
        } catch {}

        basePipeline.add(q);
        basePipeline.add(subTee);
        basePipeline.add(fake);

        // Link main tee pad -> queue sink
        const qSink = q.getStaticPad("sink");
        if (!qSink) throw new Error("Failed to get branch queue sink pad");
        if (srcPad.link(qSink) !== Gst.PadLinkReturn.OK)
            throw new Error("Failed to link main tee to branch queue");

        // Link queue -> subTee -> fakesink (keep flowing when no clients)
        if (!q.link(subTee)) throw new Error("Failed to link queue to sub-tee");
        const subPad = subTee.getRequestPad("src_%u");
        if (!subPad) throw new Error("Failed to request sub-tee src pad");
        const fakeSinkPad = fake.getStaticPad("sink");
        if (!fakeSinkPad) throw new Error("Failed to get fakesink pad");
        if (subPad.link(fakeSinkPad) !== Gst.PadLinkReturn.OK)
            throw new Error("Failed to link sub-tee to fakesink");

        // Set to PLAYING now so branches are ready
        q.setState(Gst.State.PLAYING);
        subTee.setState(Gst.State.PLAYING);
        fake.setState(Gst.State.PLAYING);

        branchPool.push({
            index: i,
            mainTeePad: srcPad,
            queue: q,
            tee: subTee,
            clients: 0,
        });
    }
}

function acquireLeastLoadedBranch(): Branch | null {
    if (!branchPool.length) return null;
    let best = branchPool[0];
    for (const b of branchPool) if (b.clients < best.clients) best = b;
    best.clients += 1;
    log.error(`🌐 Assigned to branch ${best.index} (load=${best.clients})`);
    return best;
}

function releaseBranch(index: number) {
    const b = branchPool.find((x) => x.index === index);
    if (b && b.clients > 0) b.clients -= 1;
    log.error(`🌐 Released branch ${index} (load=${b?.clients})`);
}

/**
 * Creates a base GStreamer.
 *
 * This function constructs a GStreamer pipeline that captures audio from a PulseAudio source,
 * processes it through audio conversion and resampling, encodes it using Opus codec,
 * packages it for RTP transmission, and outputs to a tee element for distribution.
 *
 * Pipeline flow:
 * pulsesrc → audioconvert → audioresample → queue → opusenc → rtpopuspay → tee → queue → fakesink
 * * @param settings - Configuration settings for the WHEP server, including PulseAudio device and Opus codec parameters.
 * @returns Gst.Pipeline | null - Returns the constructed GStreamer pipeline or null if creation fails.
 */
export function creatBasePipeline(
    settings: WhepServerSettings
): Gst.Pipeline | null {
    try {
        // Create pipeline
        const pipeline = Gst.Pipeline.new(`base-pipeline`);
        if (!pipeline) {
            log.error("❌ Failed to create pipeline");
            return null;
        }

        const audioSrc = Gst.ElementFactory.make("pulsesrc", "audio-source");
        const audioConvert = Gst.ElementFactory.make(
            "audioconvert",
            "audio-convert"
        );
        const audioResample = Gst.ElementFactory.make(
            "audioresample",
            "audio-resample"
        );
        const queue1 = Gst.ElementFactory.make("queue", "queue1");
        const opusEnc = Gst.ElementFactory.make("opusenc", "opus-encoder");
        const rtpOpusPay = Gst.ElementFactory.make(
            "rtpopuspay",
            "rtp-opus-pay"
        );
        const queue2 = Gst.ElementFactory.make("queue", "queue2");
        const tee = Gst.ElementFactory.make("tee", "tee");
        const fakesink = Gst.ElementFactory.make("fakesink", "fakesink");

        if (
            !audioSrc ||
            !audioConvert ||
            !audioResample ||
            !queue1 ||
            !opusEnc ||
            !rtpOpusPay ||
            !queue2 ||
            !tee ||
            !fakesink
        ) {
            log.error("❌ Failed to create pipeline elements");
            return null;
        }

        // Configure elements
        audioSrc.setProperty("device", settings.pulseDevice || "default");

        // Configure opus encoder
        opusEnc.setProperty("bitrate", settings.opusBitrate || 64000);
        opusEnc.setProperty("frame-size", settings.opusFrameSize || 20);
        opusEnc.setProperty("inband-fec", settings.opusFec || false);
        opusEnc.setProperty(
            "packet-loss-percentage",
            settings.opusFecPacketLoss || 0
        );

        // Configure RTP payloader
        rtpOpusPay.setProperty("pt", 111);

        // Add elements to pipeline
        pipeline.add(audioSrc);
        pipeline.add(audioConvert);
        pipeline.add(audioResample);
        pipeline.add(queue1);
        pipeline.add(opusEnc);
        pipeline.add(rtpOpusPay);
        pipeline.add(queue2);
        pipeline.add(tee);
        pipeline.add(fakesink);

        // Link elements
        if (
            !audioSrc.link(audioConvert) ||
            !audioConvert.link(audioResample) ||
            !audioResample.link(queue1) ||
            !queue1.link(opusEnc) ||
            !opusEnc.link(rtpOpusPay) ||
            !rtpOpusPay.link(queue2) ||
            !queue2.link(tee) ||
            !tee.link(fakesink)
        ) {
            log.error("❌ Failed to link pipeline elements");
            return null;
        }

        // start base pipeline
        log.info("🚀 Starting base pipeline...");
        const ret = pipeline.setState(Gst.State.PLAYING);
        if (ret === Gst.StateChangeReturn.FAILURE) {
            log.error("❌ Failed to set pipeline to PLAYING state");
            return null;
        }
        // Build per-core branches pool
        try {
            const cores = Math.max(1, os.cpus()?.length || 1);
            log.info(`🧩 Initializing per-core branches (count=${cores})...`);
            initBranchPool(pipeline, cores);
        } catch (e) {
            log.error("❌ Failed to initialize per-core branches: " + e);
            return null;
        }

        log.info("✅ Base pipeline created successfully");

        return pipeline;
    } catch (error) {
        log.fatal(`❌ Error creating base pipeline: ${error}`);
        return null;
    }
}

/**
 * Create a new whep bin when a client connects
 * @param basePipeline - The base GStreamer pipeline to which the WHEP bin will be added.
 * @param sessionId - Whep session id
 * @returns
 */
export function createWhepBin(
    basePipeline: Gst.Pipeline | null,
    sessionId: string
): WhepBin | null {
    try {
        if (!basePipeline) {
            log.error("❌ Base pipeline is not initialized");
            return null;
        }

        // link elements to the base pipeline
        if (!basePipeline) {
            log.error("❌ Base pipeline is not initialized");
            return null;
        }

        log.info(`🔧 Creating GStreamer pipeline for session ${sessionId}`);

        const capsfilter = Gst.ElementFactory.make(
            "capsfilter",
            `caps-${sessionId}`
        );
        const webrtc = Gst.ElementFactory.make(
            "webrtcbin",
            `webrtc-${sessionId}`
        );

        if (!capsfilter || !webrtc) {
            log.error("❌ Failed to create pipeline elements");
            return null;
        }

        webrtc.on(
            "on-new-transceiver",
            (transceiver: GstWebRTC.WebRTCRTPTransceiver) => {
                transceiver.direction =
                    GstWebRTC.WebRTCRTPTransceiverDirection.SENDONLY;
                transceiver.setProperty(
                    "fec-type",
                    GstWebRTC.WebRTCFECType.ULP_RED
                );
                transceiver.setProperty("do-nack", true);
            }
        );

        // Add elements to pipeline
        basePipeline.add(capsfilter);
        basePipeline.add(webrtc);

        const webrtcSinkpad = webrtc.requestPadSimple("sink_%u");
        if (!webrtcSinkpad) {
            log.error("❌ Failed to request webrtc sink pad");
            return null;
        }

        const capsfilterSrcPad = capsfilter.getStaticPad("src");
        if (!capsfilterSrcPad) {
            log.error("❌ Failed to get capsfilter src pad");
            return null;
        }

        if (capsfilterSrcPad.link(webrtcSinkpad) !== Gst.PadLinkReturn.OK) {
            log.error("❌ Failed to link capsfilter to webrtc");
            return null;
        }

        // Acquire least-loaded branch and request a src pad from its tee for this client
        const branch = acquireLeastLoadedBranch();
        if (!branch) {
            log.error("❌ No available branches to attach client");
            return null;
        }

        const teeSrcpad = branch.tee.getRequestPad("src_%u");
        if (!teeSrcpad) {
            log.error("❌ Failed to request src pad from per-core tee");
            // roll back client count
            releaseBranch(branch.index);
            return null;
        }

        const whepBin: WhepBin = {
            capsfilter,
            webrtc,
            teeSrcpad,
            tee: branch.tee,
            branchIndex: branch.index,
        };

        return whepBin;
    } catch (error) {
        log.error(`❌ Error creating whepBin: ${error}`);
        return null;
    }
}

/**
 * Starts whep bin for client
 * @param whepBin
 * @returns
 */
export function startBin(whepBin: WhepBin): boolean {
    try {
        if (!whepBin) {
            log.error("❌ WHEP bin is not initialized");
            return false;
        }

        // Set the state of the capsfilter to PLAYING
        const ret2 = whepBin.capsfilter.setState(Gst.State.PLAYING);
        if (ret2 === Gst.StateChangeReturn.FAILURE) {
            log.error("❌ Failed to set capsfilter to PLAYING state");
            return false;
        }

        // Set the state of the webrtc to PLAYING
        const ret3 = whepBin.webrtc.setState(Gst.State.PLAYING);
        if (ret3 === Gst.StateChangeReturn.FAILURE) {
            log.error("❌ Failed to set webrtc to PLAYING state");
            return false;
        }

        // Link per-core tee src pad → capsfilter sink
        const capsSinkPad = whepBin.capsfilter.getStaticPad("sink");
        if (!capsSinkPad) {
            log.error("❌ Failed to get capsfilter sink pad");
            return false;
        }

        if (whepBin.teeSrcpad.link(capsSinkPad) !== Gst.PadLinkReturn.OK) {
            log.error("❌ Failed to link per-core tee to capsfilter");
            return false;
        }

        log.info("✅ WHEP bin started successfully");
        return true;
    } catch (error) {
        log.fatal(`❌ Error starting WHEP bin: ${error}`);
        return false;
    }
}

/**
 * Stop whep bin fo client
 * @param basePipeline - Base pipeline
 * @param whepBin
 * @returns
 */
export function stopBin(
    basePipeline: Gst.Pipeline | null,
    whepBin: WhepBin
): boolean {
    try {
        if (!whepBin) {
            log.error("❌ WHEP bin is not initialized");
            return false;
        }

        // unlink bin from per-core tee
        const capsSinkPad = whepBin.capsfilter.getStaticPad("sink");
        if (!capsSinkPad) {
            log.error("❌ Failed to get capsfilter sink pad");
            return false;
        }

        whepBin.teeSrcpad.unlink(capsSinkPad);

        // release pad
        whepBin.tee.releaseRequestPad(whepBin.teeSrcpad);
        // decrease load count for branch
        releaseBranch(whepBin.branchIndex);

        // Set the state of the webrtc to NULL
        const ret3 = whepBin.webrtc.setState(Gst.State.NULL);
        if (ret3 === Gst.StateChangeReturn.FAILURE) {
            log.error("❌ Failed to set webrtc to NULL state");
            return false;
        }

        // Set the state of the capsfilter to NULL
        const ret2 = whepBin.capsfilter.setState(Gst.State.NULL);
        if (ret2 === Gst.StateChangeReturn.FAILURE) {
            log.error("❌ Failed to set capsfilter to NULL state");
            return false;
        }

        // Remove elements from the base pipeline
        basePipeline?.remove(whepBin.webrtc);
        basePipeline?.remove(whepBin.capsfilter);

        log.info("✅ WHEP bin stopped successfully");
        return true;
    } catch (error) {
        log.fatal(`❌ Error stopping WHEP bin: ${error}`);
        return false;
    }
}

/**
 * Enable RTP RED for client
 * @param whepBin
 * @param enabled
 * @param distance
 * @returns
 */
export function enableRtpRed(
    whepBin: WhepBin,
    enabled: boolean = false,
    distance: number = 2
) {
    try {
        if (!enabled) return;

        let rtpredenc;
        const _bin_webrtc = whepBin.webrtc as Gst.Bin;
        const _bin = getElementByName(_bin_webrtc, "bin", false) as Gst.Bin;
        if (_bin) rtpredenc = getElementByName(_bin, "rtpredenc", false);
        else log.error("❌ Unable to set RED distance due to rtpbin not found");
        if (rtpredenc) rtpredenc.setProperty("distance", distance);
        if (rtpredenc) rtpredenc.setProperty("allow-no-red-blocks", false);
        else
            log.error(
                "❌ Unable to set RED distance due to rtpredenc not found"
            );
    } catch (e) {
        log.error("❌ Error enabling RTP RED: " + e);
        return;
    }
}

/**
 * Setup bus watch to process messages
 * @param sessions - Map of session ID to WHEPSession
 * @param basePipeline - The base GStreamer pipeline to watch for messages.
 * @returns
 */
export function setupBusWatch(
    sessions: Map<string, WHEPSession>,
    basePipeline: Gst.Pipeline | null
): void {
    if (!basePipeline) return;
    const bus = basePipeline.getBus();
    if (!bus) return;

    const msg = bus.pop();
    if (msg) {
        switch (msg.type) {
            case Gst.MessageType.ERROR:
                const [error, debug] = msg.parseError();
                log.error(
                    `❌ Error message in base pipeline: ${error.message}`
                );
                if (debug) log.error(`🐛 Debug: ${debug}`);
                break;

            case Gst.MessageType.EOS:
                log.info(`🔚 Base pipeline- End of stream`);
                // Cleanup all sessions
                for (const [sessionId] of sessions) {
                    cleanupSession(sessionId, sessions, basePipeline);
                }
                break;

            case Gst.MessageType.STATE_CHANGED:
                const [oldState, newState, pending] = msg.parseStateChanged();
                if (msg.src.name && msg.src.name === basePipeline.name) {
                    log.info(
                        `🔄 Base pipeline state changed: ${Gst.Element.stateGetName(
                            oldState
                        )} -> ${Gst.Element.stateGetName(newState)}`
                    );
                }
                break;
        }
    }

    setTimeout(() => {
        setupBusWatch(sessions, basePipeline);
    }, 100);
}
