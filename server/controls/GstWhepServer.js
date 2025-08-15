const _paNullSinkBase = require("./_paNullSinkBase");
const Spawn = require("./spawn");
const path = require("path");
const axios = require("axios");

const { Classes } = require("../modular-dm");

class GstWhepServer extends Classes(_paNullSinkBase, Spawn) {
    constructor() {
        super();
        this.port = 9090; // Default port for WHEP server
        this.opusFec = false; // Enable Opus Forward Error Correction
        this.opusFecPacketLoss = 5; // Opus FEC packet loss percentage (preset value)
        this.opusComplexity = 10; // Opus complexity level (0 - 10) where 0 is the lowest quality, and 10 is the highest quality.
        this.opusBitrate = 64; // Opus encoding target bitrate in kbps
        this.opusFrameSize = 20; // Opus frame size
        this.rtpRed = false; // Enable RED (Redundant Encoding Data) for Opus
        this.rtpRedDistance = 2; // default RED disable value
        // statistics
        this.rtt = []; // Round-trip time for the WHEP server
        this.packetLoss = []; // Packet loss statistics for the WHEP server
        this._statsInterval = 10000; // Interval for collecting statistics in milliseconds
        this._statsIntervalId = null; // Interval ID for statistics collection
        this.clientCount = 0; // Number of clients connected to the WHEP server
    }

    Init() {
        super.Init();

        // Start external processes when the underlying null-sink is ready (from extended class)
        this.on("ready", (ready) => {
            if (ready) this.startPipeline();
            else this.stopPipeline();
        });

        // Stop external processes when the control is stopped (through setting this.run to false)
        this.on("run", (run) => {
            if (run) this.startPipeline();
            else this.stopPipeline();
        });

        // clear stats on init
        this.rtt = [];
        this.packetLoss = [];
        this.clientCount = 0;
    }

    startPipeline() {
        if (this._statsIntervalId) clearInterval(this._statsIntervalId);
        if (this.ready && this.run) {
            // clear statistics when the control is started
            this.rtt = [];
            this.packetLoss = [];
            // start stats interval
            this._statsIntervalId = setInterval(
                this.getStats.bind(this),
                this._statsInterval
            );
            // start the child process for the WHEP server
            this._parent._log(
                "INFO",
                `${this._controlName} (${this.displayName}): Starting WHEP server on port ${this.port}.`
            );
            this._start_cmd(
                `node ${path.dirname(
                    process.argv[1]
                )}/child_processes/GstWhepServer_child.js --pulseDevice="${
                    this.source
                }" --port="${this.port}" --opusFec=${
                    this.opusFec
                } --opusFecPacketLoss="${
                    this.opusFecPacketLoss
                }" --opusComplexity="${this.opusComplexity}" --opusBitrate="${
                    this.opusBitrate * 1000
                }" --opusFrameSize="${this.opusFrameSize}" --rtpRed=${
                    this.rtpRed
                } --rtpRedDistance="${this.rtpRedDistance}"`
            );
            this._parent._log(
                "INFO",
                `${this._controlName} (${this.displayName}): Started WHEP server on port ${this.port}.`
            );
        }
    }

    stopPipeline() {
        // clear statistics when the control is stopped
        this.rtt = [];
        this.packetLoss = [];
        clearInterval(this._statsIntervalId);
        this._statsIntervalId = null;
        // stop the child process
        this._stop_cmd();
        this._parent._log(
            "INFO",
            `${this._controlName} (${this.displayName}): Stopped WHEP server.`
        );
    }

    /**
     * Collect statistics for the WHEP server.
     * This method is called periodically based on the statsInterval.
     * It can be extended to collect more detailed statistics as needed.
     */
    async getStats() {
        try {
            const resRtt = await axios.get(
                `http://localhost:${this.port}/sessions/stats/rtt?count=50`
            );
            if (resRtt.status === 200) {
                const data = resRtt.data;
                this.rtt = data;
            }

            const resPacketLoss = await axios.get(
                `http://localhost:${this.port}/sessions/stats/packetsLostPercent?count=50`
            );
            if (resPacketLoss.status === 200) {
                const data = resPacketLoss.data;
                this.packetLoss = data;
            }

            const resClientCount = await axios.get(
                `http://localhost:${this.port}/sessions/stats/sessionCount`
            );
            if (resClientCount.status === 200) {
                const data = resClientCount.data;
                this.clientCount = data.sessionCount || 0;
            }
        } catch (error) {
            this._parent._log(
                "ERROR",
                `${this._controlName} (${this.displayName}): Error collecting statistics: ${error.message}`
            );
        }
    }
}

module.exports = GstWhepServer;
