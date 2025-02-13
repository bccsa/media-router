let _paAudioSourceBase = require("./_paAudioSourceBase");
const util = require("util");
const exec = util.promisify(require("child_process").exec);

/**
 * PulseAudio Null Sink. This is used as a base class for virtual inputs and outputs.
 */
class _paNullSinkSourceBase extends _paAudioSourceBase {
    constructor() {
        super();
        this.sink = ""; // PulseAudio module-null-sink sink name (external)
        this._source = ""; // PulseAudio module-null-sink source name (xxx.monitor) (internal)
        this._sink = ""; // PulseAudio module-null-sink sink name (internal)
        this.source = ""; // PulseAudio module-null-sink source name (xxx.monitor) (external)
        this.channels = 1;
        this.bitDepth = 16;
        this.sampleRate = 44100;
        this.description = "test description";
        this._paSinkModuleID; // PulseAudio module instance ID
        this._paSourceModuleID; // PulseAudio module instance ID
    }

    Init() {
        super.Init();

        this.sink = `${this._paModuleName}_sink`;
        this._source = `${this._paModuleName}_sink.monitor`;
        this._sink = `${this._paModuleName}_source`;
        this.source = `${this._paModuleName}_source.monitor`;
        this.monitor = this.source;

        this.on("run", (run) => {
            if (run) {
                this._parent.PaCmdQueue(() => {
                    this._startNullSink();
                });
            } else {
                this._parent.PaCmdQueue(() => {
                    this._stopNullSink();
                });
            }
        });

        // listen for null sink creation
        this._parent.on("sinks", (sinks) => {
            if (
                sinks.find((t) => t.name == this.sink) &&
                sinks.find((t) => t.name == this._sink)
            ) {
                setTimeout(() => {
                    this.ready = true;
                }, 1000);
            } else {
                this.ready = false;
            }
        });
    }

    // Create a PulseAudio loopback-module linking the source to the sink
    _startNullSink() {
        // Start Null sink (sink)
        let cmd_sink = `pactl load-module module-null-sink sink_name=${this.sink} format=s${this.bitDepth}le rate=${this.sampleRate} channels=${this.channels} sink_properties="latency_msec=${this._parent.paLatency}"`;
        exec(cmd_sink, { silent: true })
            .then((data) => {
                if (data.stderr) {
                    this._parent._log("ERROR", data.stderr.toString());
                }

                if (data.stdout.length) {
                    this._paSinkModuleID = data.stdout.toString().trim();
                    this._parent._log(
                        "INFO",
                        `${this._controlName} (${this.displayName}): Created null-sink; ID: ${this._paSinkModuleID}`
                    );
                }
            })
            .catch((err) => {
                this._parent._log(
                    "FATAL",
                    `${this._controlName} (${this.displayName}) - Unable to start null-sink: ` +
                        err.message
                );
            });

        // Start Null sink (source)
        let cmd_source = `pactl load-module module-null-sink sink_name=${this._sink} format=s${this.bitDepth}le rate=${this.sampleRate} channels=${this.channels} sink_properties="latency_msec=${this._parent.paLatency}"`;
        exec(cmd_source, { silent: true })
            .then((data) => {
                if (data.stderr) {
                    this._parent._log("ERROR", data.stderr.toString());
                }

                if (data.stdout.length) {
                    this._paSourceModuleID = data.stdout.toString().trim();
                    this._parent._log(
                        "INFO",
                        `${this._controlName} (${this.displayName}): Created null-sink; ID: ${this._paSourceModuleID}`
                    );
                }
            })
            .catch((err) => {
                this._parent._log(
                    "FATAL",
                    `${this._controlName} (${this.displayName}) - Unable to start null-sink: ` +
                        err.message
                );
            });
    }

    // Remove PulseAudio module
    _stopNullSink() {
        // Start Null sink (sink)
        if (this._paSinkModuleID) {
            let cmd = `pactl unload-module ${this._paSinkModuleID}`;
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

                    this._paSinkModuleID = undefined;
                })
                .catch((err) => {
                    this._parent._log(
                        "FATAL",
                        `${this._controlName} (${this.displayName}):` +
                            err.message
                    );
                });
        }
        // Start Null sink (source)
        if (this._paSourceModuleID) {
            let cmd = `pactl unload-module ${this._paSourceModuleID}`;
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
                    _paSourceModuleID;
                    this._paSourceModuleID = undefined;
                })
                .catch((err) => {
                    this._parent._log(
                        "FATAL",
                        `${this._controlName} (${this.displayName}):` +
                            err.message
                    );
                });
        }
    }
}

module.exports = _paNullSinkSourceBase;
