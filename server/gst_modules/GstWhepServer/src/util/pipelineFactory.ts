import { WhepServerSettings, WHEPSession } from "../whep-server-gstreamer";
import Gst from "@girs/node-gst-1.0";
import GstWebRTC from "@girs/node-gstwebrtc-1.0";
import { getElementByName, whepBinStats, cleanupSession, log } from "./";

export type WhepBin = {
    queue: Gst.Element;
    capsfilter: Gst.Element;
    webrtc: Gst.Element;
    teeSrcpad: Gst.Pad;
    tee: Gst.Element;
    stats?: whepBinStats;
    statsIntervalId?: NodeJS.Timeout;
};

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

        const queue = Gst.ElementFactory.make("queue", `queue-${sessionId}`);
        const capsfilter = Gst.ElementFactory.make(
            "capsfilter",
            `caps-${sessionId}`
        );
        const webrtc = Gst.ElementFactory.make(
            "webrtcbin",
            `webrtc-${sessionId}`
        );

        if (!queue || !capsfilter || !webrtc) {
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
        basePipeline.add(queue);
        basePipeline.add(capsfilter);
        basePipeline.add(webrtc);

        // Link queue → capsfilter → webrtc
        if (!queue.link(capsfilter)) {
            log.error("❌ Failed to link queue to capsfilter");
            return null;
        }

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

        // Get tee and link to queue
        const tee = basePipeline.getByName("tee");
        if (!tee) {
            log.error("❌ Tee element not found in base pipeline");
            return null;
        }

        const teeSrcpad = tee.getRequestPad("src_%u");
        if (!teeSrcpad) {
            log.error("❌ Tee src pad not found in base pipeline");
            return null;
        }

        const whepBin: WhepBin = {
            queue,
            capsfilter,
            webrtc,
            teeSrcpad,
            tee,
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

        // Set the state of the queue to PLAYING
        const ret1 = whepBin.queue.setState(Gst.State.PLAYING);
        if (ret1 === Gst.StateChangeReturn.FAILURE) {
            log.error("❌ Failed to set queue to PLAYING state");
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

        const queueSinkpad = whepBin.queue.getStaticPad("sink");
        if (!queueSinkpad) {
            log.error("❌ Failed to get queue sink pad");
            return false;
        }

        if (whepBin.teeSrcpad.link(queueSinkpad) !== Gst.PadLinkReturn.OK) {
            log.error("❌ Failed to link tee to queue");
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

        // unlink bin from tee
        const queueSinkpad = whepBin.queue.getStaticPad("sink");
        if (!queueSinkpad) {
            log.error("❌ Failed to get queue sink pad");
            return false;
        }

        whepBin.teeSrcpad.unlink(queueSinkpad);

        // release pad
        whepBin.tee.releaseRequestPad(whepBin.teeSrcpad);

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

        // Set the state of the queue to NULL
        const ret1 = whepBin.queue.setState(Gst.State.NULL);
        if (ret1 === Gst.StateChangeReturn.FAILURE) {
            log.error("❌ Failed to set queue to NULL state");
            return false;
        }

        // Remove elements from the base pipeline
        basePipeline?.remove(whepBin.webrtc);
        basePipeline?.remove(whepBin.capsfilter);
        basePipeline?.remove(whepBin.queue);

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
    if (!enabled) return;

    let rtpredenc;
    const _bin_webrtc = whepBin.webrtc as Gst.Bin;
    const _bin = getElementByName(_bin_webrtc, "bin", false) as Gst.Bin;
    if (_bin) rtpredenc = getElementByName(_bin, "rtpredenc", false);
    else log.error("❌ Unable to set RED distance due to rtpbin not found");
    if (rtpredenc) rtpredenc.setProperty("distance", distance);
    if (rtpredenc) rtpredenc.setProperty("allow-no-red-blocks", false);
    else log.error("❌ Unable to set RED distance due to rtpredenc not found");
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
