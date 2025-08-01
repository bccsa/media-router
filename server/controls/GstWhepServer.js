const _paNullSinkBase = require('./_paNullSinkBase');
const path = require('path');
const GstBase = require('./GstBase');
const { Classes } = require("../modular-dm");

class GstWhepServer extends Classes(_paNullSinkBase, GstBase) {
    constructor() {
        super();
        this.port = 9090 // Default port for WHEP server
        this.opusFec = false; // Enable Opus Forward Error Correction 
        this.opusFecPacketLoss = 5; // Opus FEC packet loss percentage (preset value)
        this.opusComplexity = 10; // Opus complexity level (0 - 10) where 0 is the lowest quality, and 10 is the highest quality.
        this.opusBitrate = 64; // Opus encoding target bitrate in kbps
        this.opusFrameSize = 20; // Opus frame size
        this.rtpRed = false; // Enable RED (Redundant Encoding Data) for Opus
        this.rtpRedDistance = 2; // default RED disable value
    }

    Init() {
        super.Init();

        // Start external processes when the underlying null-sink is ready (from extended class)
        this.on('ready', ready => { this.startPipeline(); });

        // Stop external processes when the control is stopped (through setting this.run to false)
        this.on('run', run => {
            this.startPipeline();
        });
    }
    
    startPipeline() {
        if (this.ready && this.run) {
            this._parent._log(
                    "INFO",
                    `${this._controlName} (${this.displayName}): ready:${this.ready} run: ${this.run} port: ${this.port} opusFec: ${this.opusFec} opusFecPacketLoss: ${this.opusFecPacketLoss} opusComplexity: ${this.opusComplexity} opusBitrate: ${this.opusBitrate} opusFrameSize: ${this.opusFrameSize} rtpRed: ${this.rtpRed} rtpRedDistance: ${this.rtpRedDistance}`
                );
       }
    }
}

module.exports = GstWhepServer;