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
        this._sinkStarted = false; // Remove existing sink
        this._sourceStarted = false; // Remove existing sink
    }

    Init() {
        super.Init();
        this._sinkStarted = false; // always reset value on startup
        this._sourceStarted = false; // always reset value on startup

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
                    this._stopNullSinks();
                });
            }
        });

        // listen for null sink creation
        this._parent.on("sinks", (sinks) => {
            if (
                sinks.find((t) => t.name == this.sink) &&
                sinks.find((t) => t.name == this._sink) &&
                this._sourceStarted &&
                this._sinkStarted
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
    async _startNullSink() {
        // Start Null sink (sink)
        const sinkExists = this.findPAModuleID(this.sink);
        if (sinkExists) {
            await this._stopNullSink(sinkExists.moduleID);
            await new Promise((res) => setTimeout(res, 1000));
        }
        this._paSinkModuleID = await this._createNullSink(this.sink);
        this._sinkStarted = true;

        // Start Null sink (source)
        const sourceExists = this.findPAModuleID(this._sink);
        if (sourceExists) {
            await this._stopNullSink(sourceExists.moduleID);
            await new Promise((res) => setTimeout(res, 1000));
        }
        this._paSourceModuleID = await this._createNullSink(this._sink);
        this._sourceStarted = true;

        // notify parent that the sink is ready
        this._parent.emit("sinks", this._parent.sinks);
    }

    _createNullSink(sink) {
        return new Promise((resolve, reject) => {
            let cmd_source = `pactl load-module module-null-sink sink_name=${sink} format=s${this.bitDepth}le rate=${this.sampleRate} channels=${this.channels} sink_properties="latency_msec=${this._parent.paLatency}"`;
            exec(cmd_source, { silent: true })
                .then((data) => {
                    if (data.stderr) {
                        this._parent._log("ERROR", data.stderr.toString());
                    }

                    if (data.stdout.length) {
                        const _id = data.stdout.toString().trim();
                        this._parent._log(
                            "INFO",
                            `${this._controlName} (${this.displayName}): Created null-sink; ID: ${_id}`
                        );
                        resolve(_id);
                        return;
                    }

                    resolve(undefined);
                })
                .catch((err) => {
                    this._parent._log(
                        "FATAL",
                        `${this._controlName} (${this.displayName}) - Unable to start null-sink: ` +
                            err.message
                    );
                    resolve(undefined);
                });
        });
    }

    // Remove PulseAudio module
    async _stopNullSinks() {
        // Start Null sink (sink)
        if (this._paSinkModuleID) {
            await this._stopNullSink(this._paSinkModuleID);
            this._sinkStarted = false;
            this._paSinkModuleID = undefined;
        }
        // Start Null sink (source)
        if (this._paSourceModuleID) {
            await this._stopNullSink(this._paSourceModuleID);
            this._paSourceModuleID = undefined;
            this._sourceStarted = false;
        }
    }

    /**
     * Stop a null sink
     * @param {*} moduleID
     * @returns
     */
    _stopNullSink(moduleID) {
        return new Promise((resolve, reject) => {
            let cmd = `pactl unload-module ${moduleID}`;
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
                    resolve();
                })
                .catch((err) => {
                    this._parent._log(
                        "FATAL",
                        `${this._controlName} (${this.displayName}):` +
                            err.message
                    );
                    resolve();
                });
        });
    }

    // Check if module already exists
    findPAModuleID(name) {
        return this._parent.sinks.find((s) => s.name == name);
    }
}

module.exports = _paNullSinkSourceBase;
