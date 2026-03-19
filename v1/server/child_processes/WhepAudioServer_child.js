const {
    WHEPGStreamerServer,
} = require("../gst_modules/WhepAudioServer/dist/index.js");
const args = require("minimist")(process.argv.slice(2));

const settings = {
    pulseDevice: args.pulseDevice,
    port: args.port,
    opusFec: args.opusFec == "true", // Convert string to boolean,
    opusFecPacketLoss: args.opusFecPacketLoss,
    opusComplexity: args.opusComplexity,
    opusBitrate: args.opusBitrate,
    opusFrameSize: args.opusFrameSize,
    rtpRed: args.rtpRed == "true", // Convert string to boolean
    rtpRedDistance: args.rtpRedDistance,
};

const _whepServer = new WHEPGStreamerServer(settings);

_whepServer.start(parseInt(settings.port));
