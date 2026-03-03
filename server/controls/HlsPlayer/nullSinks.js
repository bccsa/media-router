const util = require("util");
const exec = util.promisify(require("child_process").exec);

class NullSinks {
    constructor() {
        this.sinkspaModuleID = [];
        this.readyNullSinks = 0;
        this._enabledStreams = 0;
        this._nullSinksReady = 0;
    }

    InitNullSinks() {
        // Start external processes when the underlying null-sink is ready (from extended class)
        this.on("ready", (ready) => {
            if (ready) {
                this._createNullSinks();
            }

            // reset hlsLoading
            this.hlsLoading = false;
        });

        // Recreate null sinks when audio streams change (user enables/disables a language)
        this.on("audioStreams", () => {
            if (!this.ready || !this.run) return;

            // Stop running pipeline — it needs to be rebuilt with the new audio streams
            if (this.runningSrt) {
                this._stop_srt();
            } else {
                this.stop_gst();
            }

            // Remove all existing per-language null sinks
            while (this.sinkspaModuleID.length > 0) {
                this._stopHlsNullSink(this.sinkspaModuleID.pop());
            }

            // Recreate null sinks for the new set of enabled streams
            this._createNullSinks();
        });

        // Stop external processes when the control is stopped (through setting this.run to false)
        this.on(
            "run",
            (run) => {
                if (!run) {
                    while (this.sinkspaModuleID.length > 0) {
                        this._stopHlsNullSink(this.sinkspaModuleID.pop());
                    }
                }
            },
            { immediate: true }
        );
    }

    /**
     * Create null sinks for all enabled non-default audio streams.
     * Counts required sinks first, then creates them async.
     * readyNullSinks event only fires once ALL sinks are created.
     */
    _createNullSinks() {
        this._enabledStreams = 0;
        this._nullSinksReady = 0;

        // Count required sinks first (synchronous)
        this.audioStreams.forEach((stream) => {
            if (
                stream.enabled &&
                stream.language != this.defaultLanguage
            ) {
                this._enabledStreams++;
            }
        });

        // No extra sinks needed — signal ready immediately
        if (this._enabledStreams === 0) {
            this.readyNullSinks = -1;
            this.readyNullSinks = 0;
            return;
        }

        // Reset readyNullSinks to -1 so the dm event fires when sinks complete
        // (if the value was already equal to _enabledStreams from a previous run,
        // setting it again wouldn't trigger the event without this reset)
        this.readyNullSinks = -1;

        // Start async creation — readyNullSinks fires inside _startHlsNullSink
        // only when the last sink completes
        this.audioStreams.forEach((stream) => {
            if (
                stream.enabled &&
                stream.language != this.defaultLanguage
            ) {
                this._startHlsNullSink(stream.language, stream.comment);
            }
        });
    }

    // Create a PulseAudio loopback-module linking the source to the sink
    _startHlsNullSink(i, comment) {
        this._parent.PaCmdQueue(() => {
            // let cmd = `pactl load-module module-null-sink sink_name=${this._paModuleName} format=s${this.bitdepth}le rate=${this.sampleRate} channels=${this.channels} sink_properties="latency_msec=${this.latency_msec},device.description='${this.description}'"`;
            let cmd = `pactl load-module module-null-sink sink_name=${this._controlName}_sink_${i} format=s${this.bitDepth}le rate=${this.sampleRate} channels=2 sink_properties="latency_msec=${this._parent.paLatency} device.description='${this._controlName}_sink_${i} (${comment})'"`;
            exec(cmd, { silent: true })
                .then((data) => {
                    if (data.stderr) {
                        this._parent._log("ERROR", data.stderr.toString());
                    }

                    if (data.stdout.length) {
                        const moduleId = data.stdout.toString().trim();
                        this.sinkspaModuleID.push(moduleId);
                        // save module id's to clear old modules on startup
                        this.NotifyProperty("sinkspaModuleID");
                        this._nullSinksReady++;
                        this._parent._log(
                            "INFO",
                            `${this._controlName} (${this.displayName}): Created null-sink; ID: ${moduleId}  (sink_${i})`
                        );

                        // Only trigger pipeline start when ALL sinks are created
                        if (this._nullSinksReady === this._enabledStreams) {
                            this.readyNullSinks = this._enabledStreams;
                        }
                    }
                })
                .catch((err) => {
                    this._parent._log(
                        "FATAL",
                        `${this._controlName} (${this.displayName}) - Unable to start null-sink  (sink_${i}): ` +
                            err.message
                    );
                });
        });
    }

    // Remove PulseAudio module
    _stopHlsNullSink(_paModuleID) {
        this._parent.PaCmdQueue(() => {
            if (_paModuleID) {
                let cmd = `pactl unload-module ${_paModuleID}`;
                exec(cmd, { silent: true })
                    .then((data) => {
                        if (data.stderr) {
                            this._parent._log("ERROR", data.stderr.toString());
                        } else {
                            this._parent._log(
                                "INFO",
                                `${this._controlName} (${this.displayName}): Removed null-sink`
                            );
                        }
                    })
                    .catch((err) => {
                        this._parent._log(
                            "FATAL",
                            `${this._controlName} (${this.displayName}):` +
                                err.message
                        );
                    });
            }
        });
    }
}

module.exports = NullSinks;
