const util = require("util");
const exec = util.promisify(require("child_process").exec);

class PulseAudio {
    constructor() {
        this._sources = {};
        this._sinks = {};
        this.sources = []; // json sources list for front-end
        this.sinks = []; // json sinks list for front-end
        this._udpSocketPortIndex = 2000;
        this.paLatency = 50; // PulsAudio modules latency (applied to each dynamically loaded PulseAudio module). Lower latency gives higher PulseAudio CPU usage.
        this._paServerType = ""; // PulseAudio server type (PipeWire or PulseAudio)
    }

    InitPulseAudio() {
        // Get the PulseAudio server type
        this._getPAserver()
            .then((serverType) => {
                this._paServerType = serverType;
                return this._getPA("");
            })
            .then((m) => {
                // Unload all loopback, nullsink, remap-source and remap-sink modules
                let modules;
                if (this._paServerType == "PipeWire") {
                    // PipeWire does not keep the PulseAudio driver name (just shows PipeWire), so we need to filter on the name prefix.
                    modules = Object.values(m).filter(
                        (t) =>
                            (t.loopback_name &&
                                t.loopback_name.indexOf("MR_PA_") >= 0) ||
                            (t.source_name &&
                                t.source_name.indexOf("MR_PA_") >= 0) ||
                            (t.sink_name &&
                                t.sink_name.indexOf("MR_PA_") >= 0) ||
                            (t.Name && t.Name.indexOf("MR_PA_") >= 0)
                    );
                } else {
                    // PulseAudio does not allow storing names on all modules (e.g. module-loopback), so we need to filter on all module types than the Media Router is dynamically adding.
                    modules = Object.values(m).filter(
                        (t) =>
                            t.Driver &&
                            (t.Driver.search("module-loopback") >= 0 ||
                                t.Driver.search("module-remap") >= 0 ||
                                t.Driver.search("module-null-sink") >= 0) &&
                            t["Owner Module"] &&
                            t.Name
                    );
                }

                modules.forEach((paModule) => {
                    let cmd = `pactl unload-module ${paModule["Owner Module"]}`;
                    exec(cmd, { silent: true })
                        .then((data) => {
                            if (data.stderr) {
                                this._log("ERROR", data.stderr.toString());
                            } else {
                                this._log(
                                    "FATAL",
                                    `${this._controlName} (${this.displayName}): Removed ${paModule.Name}`
                                );
                            }
                        })
                        .catch((err) => {
                            this._log("FATAL", err.message);
                        });
                });

                // Startup delay after unloading modules
                setTimeout(() => {
                    this.startupDelay = false;
                    this.runCmd = this.run;
                }, this.startupDelayTime);
            })
            .catch((err) => {
                this._log("FATAL", err.toString());
            });

        // PulseAudio items detection
        this._updatePAlist("sources", this._sources).then((updated) => {
            if (updated) this.sources = Object.values(this._sources);
        });
        this._updatePAlist("sinks", this._sinks).then((updated) => {
            if (updated) this.sinks = Object.values(this._sinks);
        });
        let scanTimer = setInterval(async () => {
            this.PaCmdQueue(() => {
                this._updatePAlist("sources", this._sources).then((updated) => {
                    if (updated) this.sources = Object.values(this._sources);
                });
            });
            this.PaCmdQueue(() => {
                this._updatePAlist("sinks", this._sinks).then((updated) => {
                    if (updated) this.sinks = Object.values(this._sinks);
                });
            });
        }, 1000);
    }

    /**
     * Gets a list of PulseAudio items in json format.
     * @param {string} type - Valid type are modules, sinks, sources, sink-inputs, source-outputs, clients, samples, cards
     * @returns - Promise
     */
    _getPA(type) {
        function get(type) {
            return new Promise((resolve, reject) => {
                exec("pactl -fjson list " + type, { silent: true })
                    .then((data) => {
                        if (data.stderr) reject(stderr);
                        let arr = [];
                        try {
                            arr = JSON.parse(data.stdout);
                        } catch (err) {
                            this._log(
                                "ERROR",
                                `${_this._controlName} (${_this.displayName}): ${err.message}`
                            );
                        }
                        resolve(arr);
                    })
                    .catch((err) => {
                        reject(err);
                    });
            });
        }

        return get(type);
    }

    /**
     * Update a list of PulseAudio items
     * @param {string} type - Valid types are modules, sinks, sources, sink-inputs, source-outputs, clients, samples, cards
     * @param {object} dst - Destination object to be updated with sources and destinations
     * @returns {boolean} - Returns a promise resolving to true if the destination object (dst) has been updated
     */
    async _updatePAlist(type, dst) {
        return new Promise(async (resolve, reject) => {
            try {
                await this._getPA(type)
                    .then(async (data) => {
                        let active = {};
                        let updated = false;

                        // Add new items to dst
                        for (const item of Object.values(data)) {
                            if (item.name) {
                                // Mark item as active
                                active[item.name] = true;

                                // Add to dst if not existing
                                if (!dst[item.name]) {
                                    let ch =
                                        item["sample_specification"].match(
                                            /[0-9][0-9]*ch/gi
                                        );
                                    if (ch[0])
                                        ch = parseInt(
                                            ch[0].match(/[0-9][0-9]*/gi)
                                        );

                                    let bitDepth = item[
                                        "sample_specification"
                                    ].match(/(float|[sf])\d{1,2}[a-z]{0,2}/gi);
                                    if (bitDepth[0])
                                        bitDepth = parseInt(
                                            bitDepth[0].match(/[0-9][0-9]*/gi)
                                        );

                                    let sampleRate =
                                        item["sample_specification"].match(
                                            /[1-9]\d*Hz/gi
                                        );
                                    if (sampleRate[0])
                                        sampleRate = parseInt(
                                            sampleRate[0].match(/[0-9][0-9]*/gi)
                                        );

                                    // description
                                    let description = item.description;
                                    let descIteration = 0;
                                    while (
                                        Object.values(dst).find(
                                            (t) => t.description == description
                                        ) != undefined
                                    ) {
                                        descIteration++;
                                        description = `${item.description} (${descIteration})`;
                                    }

                                    if (
                                        item.description &&
                                        typeof ch === "number" &&
                                        ch > 0
                                    ) {
                                        dst[item.name] = {
                                            name: item.name,
                                            description: description,
                                            channels: ch,
                                            bitDepth: bitDepth,
                                            sampleRate: sampleRate,
                                            monitorsource:
                                                item["monitor_source"],
                                            channelmap:
                                                item["channel_map"].split(","),
                                            cardId: item.properties[
                                                "alsa.card"
                                            ],
                                            // mute: item.mute,
                                        };
                                    }

                                    // set alsa input / output / auto gain control
                                    await this._setAlsaInputDefaults(
                                        item.properties["alsa.card"]
                                    );

                                    updated = true;
                                    this._log(
                                        "INFO",
                                        `PulseAudio ${type} detected: ${item.name}`
                                    );
                                }
                            }
                        }

                        // Remove old items from dst
                        Object.keys(dst).forEach((itemName) => {
                            if (!active[itemName]) {
                                delete dst[itemName];
                                updated = true;
                                this._log(
                                    "INFO",
                                    `PulseAudio ${type} removed: ${itemName}`
                                );
                            }
                        });

                        resolve(updated);
                    })
                    .catch((err) => {
                        this._log("FATAL", err.message);
                        resolve(false);
                    });
            } catch (err) {
                this._log("FATAL", err.message);
                resolve(false);
            }
        });
    }

    /**
     * Set alsa device input / output gain by default to 100% and auto gain control to off
     * @param {*} cardId - alsa device card id
     */
    async _setAlsaInputDefaults(cardId) {
        return new Promise((resolve, reject) => {
            if (!cardId || cardId == undefined) resolve();
            else
                exec(`amixer -c ${cardId} controls`)
                    .then(async (result) => {
                        if (!result.stdout) return;
                        let controls = result.stdout.split("\n");
                        for (const control of controls) {
                            if (control.indexOf("Capture Volume") >= 0) {
                                await exec(
                                    `amixer -c ${cardId} cset ${control} 100%`
                                ).catch((err) => {
                                    this._log(
                                        "ERROR",
                                        "Unable to set alsa input volume to 100%: " +
                                            err.message
                                    );
                                });
                            } else if (
                                control.indexOf("Playback Volume") >= 0 &&
                                !(control.indexOf("Mic Playback Volume") >= 0)
                            ) {
                                await exec(
                                    `amixer -c ${cardId} cset ${control} 100%`
                                ).catch((err) => {
                                    this._log(
                                        "ERROR",
                                        "Unable to set alsa output volume to 100%: " +
                                            err.message
                                    );
                                });
                            } else if (
                                control.indexOf("Auto Gain Control") >= 0
                            ) {
                                await exec(
                                    `amixer -c ${cardId} cset ${control} off`
                                ).catch((err) => {
                                    this._log(
                                        "ERROR",
                                        "Unable to set alsa auto gain control to off: " +
                                            err.message
                                    );
                                });
                            }
                        }
                        resolve();
                    })
                    .catch((err) => {
                        this._log(
                            "ERROR",
                            "Unable to set alsa input defaults: " + err.message
                        );
                    });
        });
    }

    /**
     * Get the PulseAudio server type
     * @returns Promise with the PulseAudio server type (PipeWire or PulseAudio)
     */
    _getPAserver() {
        return new Promise((resolve, reject) => {
            exec("pactl info")
                .then((result) => {
                    if (result.stdout.indexOf("PipeWire") >= 0) {
                        resolve("PipeWire");
                    } else {
                        resolve("PulseAudio");
                    }
                })
                .catch((err) => {
                    reject(
                        "Unable to determine the PulseAudio server type: " +
                            err.toString()
                    );
                });
        });
    }

    /**
     * Get next available UDP socket port
     */
    GetUdpSocketPort() {
        this._udpSocketPortIndex++;
        return this._udpSocketPortIndex;
    }
}

module.exports = PulseAudio;
