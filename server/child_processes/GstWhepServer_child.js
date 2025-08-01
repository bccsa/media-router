const { WHEPGStreamerServer } = require("../gst-whep-server/dist/index.js");

const pulseDevice = process.argv[2];
const port = process.argv[3] || 9090; // Default port for WHEP server

const _whepServer = new WHEPGStreamerServer(pulseDevice);

_whepServer.start(parseInt(port));
