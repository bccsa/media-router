const util = require("util");
const exec = util.promisify(require("child_process").exec);
const vuMeter = require("./vuMeter");
const _routerChildControlBase = require("./_routerChildControlBase");
const { Classes } = require("../modular-dm");
const path = require("path");

/**
 * Base class for PulseAudio sources and sinks.
 * Implementing classes should be self-sufficient and should be able to start/stop without relying on other classes' ready or running status'.
 */
class _paAudioBase extends Classes(_routerChildControlBase, vuMeter) {
    constructor() {
        super();
        this._paModuleName = ""; // Unique name used for dynamically created PulseAudio modules
        this.soloGroup = "";
        this.mute = false;
        this.showVolumeControl = true; // Show volume slider on local client
        this.showMuteControl = true; // Show mute button on local client
        this.showControl = true; // show control on local client
        this.displayOrder = 0; // display order on client interface
        this.clientControl = "client_AudioInputDevice";
        this.monitor = ""; // PulseAudio monitor source
        this.SetAccess("monitor", { Set: "none" });
        this._vu = []; // internal vu array
        this._vuPrev = []; // Previous vu values array
        this._vuInterval; // VU indication interval timer
        this.vuInterval = 100; // VU meter indication interval in milliseconds
        this.SetAccess("vuData", { Set: "none" });
        this.enableVU = true; // true: Enable VU calculation
        this.channels = 1; // Audio channels
        this.bitDepth = 16; // Audio bit depth
        this.sampleRate = 48000; // Audio sample rate
        this.volume = 100; // Requested volume in %
        this.maxVolume = 150; // Maximum permissible volume
        this.runVU = false; // VU meter run command - this should not be set from external code
        this.SetAccess("runVU", { Get: "none", Set: "none" });
        this._setVolTimer; // Timer for rate limiting _setVolume actions
        this.enableVolControl = false;
        this.SetAccess("enableVolControl", { Set: "none", Get: "none" });
        this._vuDataListener = undefined; // eventlistener for vuData, used to unsubscribe
        this.srcChannelMap = ""; // srcMap used with loopback to be able to select the audio channels you want to pass
    }

    Init() {
        this.InitBase();
        // Set PulseAudio Module name
        this._paModuleName = "MR_PA_" + this._controlName;

        // Mute all other modules (with the same parent) in the solo group
        this.on(
            "mute",
            (mute) => {
                if (!mute && this.soloGroup) {
                    Object.values(this._parent._controls)
                        .filter((c) => c.soloGroup == this.soloGroup)
                        .forEach((m) => {
                            if (m._controlName != this._controlName && !m.mute)
                                m.mute = true;
                        });
                }
            },
            { immediate: true }
        );

        // Start / stop the VU meter
        this.on("runVU", (run) => {
            if (run) {
                this._parent
                    .PaCmdQueue(() => {
                        this._startVU();
                    })
                    .catch((err) => {
                        this._parent._log(
                            "FATAL",
                            `${this._paModuleName} (${this.displayName}): ${err.message}`
                        );
                    });
            } else {
                this._parent
                    .PaCmdQueue(() => {
                        this._stopVU();
                    })
                    .then(() => {
                        // unsubscribe from vuData
                        this.off("vuData", this._vuDataListener);
                        this._vuDataListener = undefined;
                        // Clear vu meter indication
                        for (let i = 0; i < this._vu.length; i++) {
                            this._vu[i] = -60;
                        }

                        this._notify({ vuData: this._vu });
                        this._vuPrev = [...this._vu]; // create a shallow copy of the internal VU array
                    })
                    .catch((err) => {
                        this._parent._log(
                            "FATAL",
                            `${this._paModuleName} (${this.displayName}): ${err.message}`
                        );
                    });
            }
        });

        this.on(
            "run",
            (run) => {
                this.runVU = this.run && this.ready && this.enableVU;
                this.enableVolControl = this.run && this.ready;
            },
            { immediate: true }
        );

        this.on(
            "ready",
            (ready) => {
                this.runVU = this.run && this.ready && this.enableVU;
                this.enableVolControl = this.run && this.ready;
            },
            { immediate: true }
        );

        this.on(
            "enableVU",
            () => {
                this.runVU = this.run && this.ready && this.enableVU;
            },
            { immediate: true }
        );

        // Start volume and mute event handlers
        this.on("enableVolControl", (enable) => {
            let _volEventHandler;
            let _muteEventHandler;
            if (enable) {
                _volEventHandler = this.on(
                    "volume",
                    (volume) => {
                        this._setVolume(volume);
                    },
                    { immediate: true }
                );

                _muteEventHandler = this.on(
                    "mute",
                    (mute) => {
                        this._setMute(mute);
                    },
                    { immediate: true }
                );
            } else if (_volEventHandler && _muteEventHandler) {
                this.off("volume", _volEventHandler);
                this.off("mute", _muteEventHandler);
            }
        });
    }

    _startVU() {
        this._parent._log(
            "INFO",
            `${this._paModuleName} (${this.displayName}): Starting VU`
        );
        const _pl = `pulsesrc device=${this.monitor} ! audio/x-raw,channels=${
            this.channels
        } ! level peak-falloff=120 peak-ttl=50000000 interval=${
            this.vuInterval * 1000000
        } ! fakesink silent=true`;
        const _path = `${path.dirname(
            process.argv[1]
        )}/child_processes/vu_child.js`;
        this.start_vu(_path, [_pl]);
        // start vu
        this._vuDataListener = this.on("vuData", (data) => {
            if (data && data.decay_dB) {
                this._vu = [];
                Object.values(data.decay_dB).forEach((val, i) => {
                    let _tempVu = Math.round(val);
                    if (_tempVu < -60) _tempVu = -60;
                    this._vu[i] = Math.round(0.25 * ( 60 + _tempVu));
                });

                if (JSON.stringify(this._vuPrev) != JSON.stringify(this._vu)) {
                    this._notify({ vuData: this._vu }); // Notifies with through _topLevelParent.on('data', data => {});
                    this._vuPrev = this._vu;
                }
            }
        });
    }

    _stopVU() {
        this._parent._log(
            "INFO",
            `${this._paModuleName} (${this.displayName}): Stopping VU`
        );
        this.stop_vu();
    }

    /**
     * Set source or sink mute
     * @param {boolean} mute - true = mute; false = unmute
     */
    _setMute(mute) {
        let m;
        if (mute) {
            m = "1";
        } else {
            m = "0";
        }

        let type;
        if (this.source) {
            type = "source";
        } else if (this.sink) {
            type = "sink";
        }

        let cmd = `pactl set-${type}-mute ${this[type]} ${m}`;
        exec(cmd, { silent: true })
            .then((data) => {
                if (data.stderr) {
                    this._parent._log(
                        "ERROR",
                        `${this._paModuleName} (${
                            this.displayName
                        }): ${data.stderr.toString()}`
                    );
                }
            })
            .catch((err) => {
                this._parent._log(
                    "FATAL",
                    `${this._paModuleName} (${this.displayName}): ${err.message}`
                );
            });
    }

    /**
     * Set source or sink volume
     */
    _setVolume(volume) {
        if (!this._setVolTimer) {
            let type;
            if (this.source) {
                type = "source";
            } else if (this.sink) {
                type = "sink";
            }

            let cmd = `pactl set-${type}-volume ${this[type]} ${volume}%`;
            exec(cmd, { silent: true })
                .then((data) => {
                    if (data.stderr) {
                        this._parent._log(
                            "ERROR",
                            `${this._paModuleName} (${
                                this.displayName
                            }): ${data.stderr.toString()}`
                        );
                    }
                })
                .catch((err) => {
                    this._parent._log(
                        "FATAL",
                        `${this._paModuleName} (${this.displayName}): ${err.message}`
                    );
                });

            let prevVol = volume;

            this._setVolTimer = setTimeout(() => {
                delete this._setVolTimer;
                if (volume != prevVol) {
                    this._setVolume(volume);
                }
            }, 5);
        }
    }
}

module.exports = _paAudioBase;
