import { WhepServerSettings } from "../whep-server-gstreamer";
import Gst from "@girs/node-gst-1.0";
import GstWebRTC from "@girs/node-gstwebrtc-1.0";

export type WhepBin = {
    queue: Gst.Element;
    capsfilter: Gst.Element;
    webrtc: Gst.Element;
    teeSrcpad: Gst.Pad;
    tee: Gst.Element;
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
            console.error("❌ Failed to create pipeline");
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
            console.error("❌ Failed to create pipeline elements");
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
            console.error("❌ Failed to link pipeline elements");
            return null;
        }

        // start base pipeline
        console.log("🚀 Starting base pipeline...");
        const ret = pipeline.setState(Gst.State.PLAYING);
        if (ret === Gst.StateChangeReturn.FAILURE) {
            console.error("❌ Failed to set pipeline to PLAYING state");
            return null;
        }
        console.log("✅ Base pipeline created successfully");

        return pipeline;
    } catch (error) {
        console.error("❌ Error creating base pipeline:", error);
        return null;
    }
}

export function createWhepBin(
    basePipeline: Gst.Pipeline | null,
    sessionId: string
): WhepBin | null {
    try {
        if (!basePipeline) {
            console.error("❌ Base pipeline is not initialized");
            return null;
        }

        // link elements to the base pipeline
        if (!basePipeline) {
            console.error("❌ Base pipeline is not initialized");
            return null;
        }

        console.log(`🔧 Creating GStreamer pipeline for session ${sessionId}`);

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
            console.error("❌ Failed to create pipeline elements");
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
            console.error("❌ Failed to link queue to capsfilter");
            return null;
        }

        const webrtcSinkpad = webrtc.requestPadSimple("sink_%u");
        if (!webrtcSinkpad) {
            console.error("❌ Failed to request webrtc sink pad");
            return null;
        }

        const capsfilterSrcPad = capsfilter.getStaticPad("src");
        if (!capsfilterSrcPad) {
            console.error("❌ Failed to get capsfilter src pad");
            return null;
        }

        if (capsfilterSrcPad.link(webrtcSinkpad) !== Gst.PadLinkReturn.OK) {
            console.error("❌ Failed to link capsfilter to webrtc");
            return null;
        }

        // Get tee and link to queue
        const tee = basePipeline.getByName("tee");
        if (!tee) {
            console.error("❌ Tee element not found in base pipeline");
            return null;
        }

        const teeSrcpad = tee.getRequestPad("src_%u");
        if (!teeSrcpad) {
            console.error("❌ Tee src pad not found in base pipeline");
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
        console.error("❌ Error creating whepBin:", error);
        return null;
    }
}

export function startBin(whepBin: WhepBin): boolean {
    try {
        if (!whepBin) {
            console.error("❌ WHEP bin is not initialized");
            return false;
        }

        // Set the state of the queue to PLAYING
        const ret1 = whepBin.queue.setState(Gst.State.PLAYING);
        if (ret1 === Gst.StateChangeReturn.FAILURE) {
            console.error("❌ Failed to set queue to PLAYING state");
            return false;
        }

        // Set the state of the capsfilter to PLAYING
        const ret2 = whepBin.capsfilter.setState(Gst.State.PLAYING);
        if (ret2 === Gst.StateChangeReturn.FAILURE) {
            console.error("❌ Failed to set capsfilter to PLAYING state");
            return false;
        }

        // Set the state of the webrtc to PLAYING
        const ret3 = whepBin.webrtc.setState(Gst.State.PLAYING);
        if (ret3 === Gst.StateChangeReturn.FAILURE) {
            console.error("❌ Failed to set webrtc to PLAYING state");
            return false;
        }

        const queueSinkpad = whepBin.queue.getStaticPad("sink");
        if (!queueSinkpad) {
            console.error("❌ Failed to get queue sink pad");
            return false;
        }

        if (whepBin.teeSrcpad.link(queueSinkpad) !== Gst.PadLinkReturn.OK) {
            console.error("❌ Failed to link tee to queue");
            return false;
        }

        console.log("✅ WHEP bin started successfully");
        return true;
    } catch (error) {
        console.error("❌ Error starting WHEP bin:", error);
        return false;
    }
}

export function stopBin(whepBin: WhepBin): boolean {
    try {
        if (!whepBin) {
            console.error("❌ WHEP bin is not initialized");
            return false;
        }

        // unlink bin from tee
        const queueSinkpad = whepBin.queue.getStaticPad("sink");
        if (!queueSinkpad) {
            console.error("❌ Failed to get queue sink pad");
            return false;
        }

        whepBin.teeSrcpad.unlink(queueSinkpad);

        // release pad
        whepBin.tee.releaseRequestPad(whepBin.teeSrcpad);

        // Set the state of the queue to NULL
        const ret1 = whepBin.queue.setState(Gst.State.NULL);
        if (ret1 === Gst.StateChangeReturn.FAILURE) {
            console.error("❌ Failed to set queue to NULL state");
            return false;
        }

        // Set the state of the capsfilter to NULL
        const ret2 = whepBin.capsfilter.setState(Gst.State.NULL);
        if (ret2 === Gst.StateChangeReturn.FAILURE) {
            console.error("❌ Failed to set capsfilter to NULL state");
            return false;
        }

        // Set the state of the webrtc to NULL
        const ret3 = whepBin.webrtc.setState(Gst.State.NULL);
        if (ret3 === Gst.StateChangeReturn.FAILURE) {
            console.error("❌ Failed to set webrtc to NULL state");
            return false;
        }

        console.log("✅ WHEP bin stopped successfully");
        return true;
    } catch (error) {
        console.error("❌ Error stopping WHEP bin:", error);
        return false;
    }
}

export function enableRtpRed(
    whepBin: WhepBin,
    enabled: boolean = false,
    distance: number = 2
) {
    if (!enabled) return;

    let rtpredenc;
    const _bin_webrtc = whepBin.webrtc as Gst.Bin;
    const _bin_rtp = _bin_webrtc.getChildByIndex(0) as Gst.Bin;
    if (_bin_rtp) rtpredenc = _bin_rtp.getChildByIndex(0);
    else console.log("❌ Unable to set RED distance due to rtpbin not found");
    if (rtpredenc) rtpredenc.setProperty("distance", distance);
    if (rtpredenc) rtpredenc.setProperty("allow-no-red-blocks", false);
    else
        console.log(
            "❌ Unable to set RED distance due to rtpredenc0 not found"
        );
}
