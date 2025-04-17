const path = require("path");
const _routerChildControlBase = require("./_routerChildControlBase");
const { Classes } = require("../modular-dm");
const SrtBase = require("./SrtBase");

class SrtRelay extends Classes(_routerChildControlBase, SrtBase) {
    constructor() {
        super();
        this._srtElementName = "srtserversink";
        this.ready = true; // override ready to true, since we are not using pipewire

        // SrtSink settings
        this.sink_srtHost = "";
        this.sink_srtPort = 1234;
        this.sink_srtMode = "caller";
        this.sink_srtPbKeyLen = 16;
        this.sink_srtPassphrase = "";
        this.sink_srtLatency = 10;
        this.sink_srtMaxBw = 250; // % of Bandwidth
        this.sink_srtEnableMaxBW = false; // Enable MaxBandwidth property for srt
        this.sink_srtStreamID = "";
    }

    Init() {
        super.Init();
        this.InitBase();

        // Start external processes on run
        this.on("run", (run) => {
            if (!run) this.stopPipeline();
            else this.startPipeline();
        });
    }

    startPipeline() {
        if (this.run && this.moduleEnabled) {
            this._parent._log(
                "INFO",
                `${this._controlName} (${this.displayName}): Starting srtRelay (gstreamer)`
            );

            let _pipeline =
                // sink
                `srtserversrc uri="${this.sink_uri()}" wait-for-connection=false ! ` +
                // source
                `srtserversink name=${
                    this._srtElementName
                } uri="${this.uri()}" sync=false wait-for-connection=false`;

            this._parent.PaCmdQueue(() => {
                this._start_srt(
                    `node ${path.dirname(
                        process.argv[1]
                    )}/child_processes/SrtGstGeneric_child.js '${_pipeline}'`,
                    this._srtElementName
                );
            });
        }
    }

    stopPipeline() {
        this._parent._log(
            "INFO",
            `${this._controlName} (${this.displayName}): Stopping srtRelay (gstreamer)`
        );
        this._stop_srt();
    }

    /**
     * Create a URI used by SRT
     * @returns - A URI used for srt
     */
    sink_uri() {
        let crypto = "";
        if (this.sink_srtPassphrase && this.sink_srtPassphrase.length >= 10) {
            crypto = `&pbkeylen=${this.sink_srtPbKeyLen}&passphrase=${this.sink_srtPassphrase}`;
        } else if (
            this.sink_srtPassphrase &&
            this.sink_srtPassphrase.length < 10
        ) {
            this._parent._log(
                "ERROR",
                `${this._controlName} (${this.displayName}): SRT Passphrase need to be 10 or more characters, Encryption not enabled`
            );
        }

        let streamID = "";
        if (this.sink_srtStreamID) {
            streamID = `&streamid=${this.sink_srtStreamID}`;
        }

        let maxBW = "";
        if (this.sink_srtEnableMaxBW) {
            maxBW = `&maxbw=${
                (Math.round(this.calcBitrate() / 8) * this.sink_srtMaxBw) / 100
            }`;
        }

        const _host =
            this.sink_srtMode == "listener" ? "0.0.0.0" : this.sink_srtHost;
        let _uri = `srt://${_host}:${this.sink_srtPort}?mode=${this.sink_srtMode}&latency=${this.sink_srtLatency}${maxBW}${streamID}${crypto}`;

        return _uri;
    }

    /**
     * Calculate Module Bitrate (Used by SRT Base to have a standard format to calculate the MaxBandwidth)
     */
    calcBitrate() {
        return 0; // bitrage 0, since maxBW cant be used with a relay
    }
}

module.exports = SrtRelay;
