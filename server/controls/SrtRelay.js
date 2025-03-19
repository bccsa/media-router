const path = require("path");
const { dm } = require("../modular-dm");
const { Classes } = require("../modular-dm");
const SrtBase = require("./SrtBase");

class SrtRelay extends Classes(dm, SrtBase) {
    constructor() {
        super();
        this.run = false; // Run command to be set by external code to request the control to start.
        this.ready = true; // Device will always be ready, since it does not need to wait for any external events like null sinks being spawned
        this.SetAccess("run", { Get: "none", Set: "none" });
        this.reload = false; // Reload configuration command. Stops and starts the control to apply changes.
        this._srtElementName = "srtserversink";
        this.displayName = ""; // Display name

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
        this.moduleEnabled = true; // Enable or disable individual module
    }

    Init() {
        super.Init();

        // Start external processes on run
        this.on("run", (run) => {
            if (!run) this.stopPipeline();
            else this.startPipeline();
        });

        this.on("moduleEnabled", (moduleEnabled) => {
            if (!moduleEnabled) this.stopPipeline();
            else this.startPipeline();
        });

        // reload control
        this.on("reload", (reload) => {
            if (reload) {
                if (this._parent.runCmd) {
                    this.run = false;
                    setTimeout(() => {
                        this.run = this._parent.runCmd;
                    }, 1000);
                }
            }
            this.reload = this._parent.runCmd;
        });

        // Stop control on removal
        this.on("remove", () => {
            this.run = false;
        });

        // Subscribe to parent (router) run command
        this._parent.on(
            "runCmd",
            (run) => {
                setTimeout(() => {
                    this.run = run;
                }); // timeout added to give the subclasses a time to add their event subscribers to the run event before the event is emited
            },
            { immediate: true, caller: this }
        );
    }

    startPipeline() {
        if (this.run && this.moduleEnabled) {
            this._parent._log(
                "INFO",
                `${this._controlName} (${this.displayName}): Starting srtRelay (gstreamer)`
            );

            let _pipeline =
                // sink
                `srtserversrc uri="${this.sink_uri()}" wait-for-connection=false ! tsparse ! ` +
                `queue leaky=2 max-size-time=200000000 flush-on-eos=true ! ` +
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

        let _uri = `srt://${this.sink_srtHost}:${this.sink_srtPort}?mode=${this.sink_srtMode}&latency=${this.sink_srtLatency}${maxBW}${streamID}${crypto}`;

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
