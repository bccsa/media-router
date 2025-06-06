const util = require("util");
const exec = util.promisify(require("child_process").exec);

class NullSinks {
    constructor() {
        this.sinkspaModuleID = [];
        this.readyNullSinks = 0;
        this._enabledStreams = 0;
    }

    InitNullSinks() {
        // Start external processes when the underlying null-sink is ready (from extended class)
        this.on("ready", (ready) => {
            if (ready) {
                // start null sinks
                this._enabledStreams = 0;
                this.readyNullSinks = -1; // Toggle to -1 that the event triggers if there is currently 0 ready null sinks and none is started
                this.readyNullSinks = 0;
                this.audioStreams.forEach((stream) => {
                    if (
                        stream.enabled &&
                        stream.language != this.defaultLanguage
                    ) {
                        this._enabledStreams++;
                        this._startHlsNullSink(stream.language, stream.comment);
                    }
                });
            }

            // reset hlsLoading
            this.hlsLoading = false;
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
                        this.sinkspaModuleID.push(
                            data.stdout.toString().trim()
                        );
                        // save module id's to clear old modules on startup
                        this.NotifyProperty("sinkspaModuleID");
                        this.readyNullSinks++;
                        this._parent._log(
                            "INFO",
                            `${this._controlName} (${this.displayName}): Created null-sink; ID: ${this._paModuleID}  (sink_${i})`
                        );
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
