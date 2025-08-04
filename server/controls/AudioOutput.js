let _paAudioSinkBase = require("./_paAudioSinkBase");
const util = require("util");
const exec = util.promisify(require("child_process").exec);

class AudioOutput extends _paAudioSinkBase {
    constructor() {
        super();
        // Set audio format settings to read-only. These settings are read from the PulseAudio server, and cannot be modified by the user.
        this.SetAccess("channels", { Set: "none" });
        this.SetAccess("bitDepth", { Set: "none" });
        this.SetAccess("sampleRate", { Set: "none" });
        this.channelMap = ""; // Input channel map
        this._channelMap = ""; // PulseAudio calculated channel map
        this._snkChannels = 0; // Master sink channel count
        this._snkChannelMap = []; // Master sink channel map
        this.master = ""; // PulseAudio master sink
        this._startingRemapSink = false; // flage thet shows remap sing is being created
    }

    Init() {
        super.Init();

        this.sink = this._paModuleName;
        this.monitor = this.sink + ".monitor";

        this.on("run", (run) => {
            let eventHandler = function (sinks) {
                if (sinks.find((t) => t.name == this.master)) {
                    if (
                        !this._paModuleID &&
                        this.run &&
                        !this._startingRemapSink
                    ) {
                        this._startingRemapSink = true; // Ensure we only create the remap sink once
                        this._map();
                        this._parent.PaCmdQueue(() => {
                            this._startRemapSink();
                        });
                    }
                } else {
                    this._parent.PaCmdQueue(() => {
                        this._stopRemapSink();
                    });
                }
            }.bind(this);

            if (run) {
                // Wait for master sink to be available before starting the remap sink
                this._parent.on("sinks", eventHandler, { immediate: true });
            } else {
                // this._parent.off('sinks', s);
                this._parent.off("sinks", eventHandler);
                this._parent.PaCmdQueue(() => {
                    this._stopRemapSink();
                });
            }
        });

        this._parent.on(
            "sinks",
            (sinks) => {
                // listen for map-sink module creation
                if (sinks.find((t) => t.name == this._paModuleName)) {
                    this.ready = true;
                } else {
                    this.ready = false;
                }

                this._map();
            },
            { immediate: true }
        );

        this.on("channelMap", () => {
            this._map();
        });

        this.on("master", () => {
            this._map();
        });
    }

    /**
     * Calculates and sets this.channels and this._channelMap from this.channelMap
     */
    _map() {
        if (this._parent._sinks[this.master]) {
            this._snkChannels = this._parent._sinks[this.master].channels;
            this._snkChannelMap = this._parent._sinks[this.master].channelmap;
            this.sampleRate = this._parent._sinks[this.master].sampleRate;
            this.bitDepth = this._parent._sinks[this.master].bitDepth;

            let masterMap = [];
            let channelCount = 0;
            let channelMap = [];

            this.channelMap.split(",").forEach((channel) => {
                let ch = parseInt(channel);
                if (ch && ch > 0 && ch <= this._snkChannels) {
                    masterMap.push(this._snkChannelMap[ch - 1]);
                    channelMap.push(ch);
                    channelCount++;
                }
            });

            // Reduce channel count if larger than master channel count
            if (channelCount > this._snkChannels) {
                channelCount = this._snkChannels;
                channelMap.splice(channelCount);
            }

            if (channelCount > 0) {
                this._channelMap = `channel_map=${this._snkChannelMap
                    .slice(0, channelCount)
                    .join(",")} master_channel_map=${masterMap.join(",")}`;
                this.channels = channelCount;
                this.channelMap = channelMap.join(",");
            } else {
                // Create default channel map
                channelMap = [];
                for (let i = 1; i <= this._snkChannels; i++) {
                    channelMap.push(i);
                }
                this.channelMap = channelMap.join(",");

                // Regenerate map
                this._map();
            }
        }
    }

    // Create a PulseAudio loopback-module linking the sink to the sink
    _startRemapSink() {
        if (this.channels > 0) {
            let cmd = `pactl load-module module-remap-sink master=${this.master} sink_name=${this._paModuleName} format=s${this.bitDepth}le rate=${this.sampleRate} channels=${this.channels} ${this._channelMap} remix=no sink_properties="latency_msec=${this._parent.paLatency}"`;
            exec(cmd, { silent: true })
                .then((data) => {
                    if (data.stderr) {
                        this._parent._log("ERROR", data.stderr.toString());
                    }

                    if (data.stdout.length) {
                        this._paModuleID = data.stdout.toString().trim();
                        this._parent._log(
                            "INFO",
                            `${this._controlName} (${this.displayName}): Created remap-sink; ID: ${this._paModuleID}`
                        );
                    }
                    this._startingRemapSink = false; // Reset the flag after creation
                })
                .catch((err) => {
                    this._parent._log(
                        "FATAL",
                        `${this._controlName} (${this.displayName}): ` +
                            err.message
                    );
                    this._paModuleID = undefined;
                });
        } else {
            this._parent._log(
                "ERROR",
                `${this._controlName} (${this.displayName}): Unable to create remap-sink: Invalid channel map`
            );
            this._paModuleID = undefined;
        }
    }

    // Remove PulseAudio module
    _stopRemapSink() {
        if (this._paModuleID) {
            let cmd = `pactl unload-module ${this._paModuleID}`;
            exec(cmd, { silent: true })
                .then((data) => {
                    if (data.stderr) {
                        this._parent._log("ERROR", data.stderr.toString());
                    } else {
                        this._parent._log(
                            "INFO",
                            `${this._controlName} (${this.displayName}): Removed remap-sink`
                        );
                    }

                    this._paModuleID = undefined;
                })
                .catch((err) => {
                    this._parent._log(
                        "FATAL",
                        `${this._controlName} (${this.displayName}): ` +
                            err.message
                    );
                    this._paModuleID = undefined;
                });
        }
    }
}

module.exports = AudioOutput;
