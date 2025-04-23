let _paAudioSourceBase = require("./_paAudioSourceBase");
const util = require("util");
const exec = util.promisify(require("child_process").exec);

/**
 * PulseAudio Null Sink. This is used as a base class for virtual inputs and outputs.
 */
class _paNullSinkBase extends _paAudioSourceBase {
    constructor() {
        super();
        this.source = ""; // PulseAudio module-null-sink source name (xxx.monitor)
        this.sink = ""; // PulseAudio module-null-sink sink name
        this.channels = 1;
        this.bitDepth = 16;
        this.sampleRate = 44100;
        this.description = "test description";
        this._paModuleID; // PulseAudio module instance ID
    }

    Init() {
        super.Init();

        this.source = `${this._paModuleName}.monitor`;
        this.sink = this._paModuleName;
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
            if (sinks.find((t) => t.name == this._paModuleName)) {
                setTimeout(() => {
                    this.ready = true;
                }, 100);
            } else {
                this.ready = false;
            }
        });
    }

    // Create a PulseAudio loopback-module linking the source to the sink
    async _startNullSink() {
        const exists = this.findPAModuleID();
        if (exists) {
            await this._stopNullSink(exists.moduleID);
            await new Promise((res) => setTimeout(res, 1000));
        }
        // let cmd = `pactl load-module module-null-sink sink_name=${this._paModuleName} format=s${this.bitdepth}le rate=${this.sampleRate} channels=${this.channels} sink_properties="latency_msec=${this.latency_msec},device.description='${this.description}'"`;
        let cmd = `pactl load-module module-null-sink sink_name=${
            this._paModuleName
        } format=s${this.bitDepth}le rate=${this.sampleRate} channels=${
            this.channels
        } sink_properties="latency_msec=${
            this._parent.paLatency
        }" sink_properties="description='${this.displayName
            .trim()
            .replace(" ", "_")}'"`;
        exec(cmd, { silent: true })
            .then((data) => {
                if (data.stderr) {
                    this._parent._log("ERROR", data.stderr.toString());
                }

                if (data.stdout.length) {
                    this._paModuleID = data.stdout.toString().trim();
                    this._parent._log(
                        "INFO",
                        `${this._controlName} (${this.displayName}): Created null-sink; ID: ${this._paModuleID}`
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

    /**
     * Stop current null-sink or the one specified by moduleID
     * @param {*} moduleID
     * @returns
     */
    _stopNullSink(moduleID) {
        return new Promise((resolve, reject) => {
            const _id = moduleID || this._paModuleID;
            if (_id) {
                let cmd = `pactl unload-module ${_id}`;
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

                        this._paModuleID = undefined;
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
            }
        });
    }

    // Check if module already exists
    findPAModuleID() {
        return this._parent.sinks.find((s) => s.name == this._paModuleName);
    }
}

module.exports = _paNullSinkBase;
