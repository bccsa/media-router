const { clearInterval } = require('timers');
let { dm } = require('../modular-dm');
const { spawn } = require('child_process');
const util = require('util');
const exec = util.promisify(require('child_process').exec);

/**
 * Base class for PulseAudio sources and sinks.
 * Implementing classes should be self-sufficient and should be able to start/stop without relying on other classes' ready or running status'.
 */
class _paAudioBase extends dm {
    constructor() {
        super();
        this.displayName = "";  // Display name
        this._paModuleName = ""; // Unique name used for dynamically created PulseAudio modules
        this.soloGroup = "";
        this.mute = false;
        this.showVolumeControl = true;  // Show volume slider on local client
        this.showMuteControl = true;    // Show mute button on local client
        this.showControl = true;        // show control on local client
        this.displayOrder = 0;  // display order on client interface
        this.clientControl = "client_AudioInputDevice";
        this.monitor = "";      // PulseAudio monitor source
        this.SetAccess('monitor', { Set: 'none' });
        this._vuProc;           // external process for VU meter
        this._vu = [];          // internal vu array
        this._vuPrev = [];      // Previous vu values array
        this._vuInterval;       // VU indication interval timer
        this._vuResetPeak = false;
        this.vuInterval = 100;  // VU meter indication interval in milliseconds
        this.SetAccess('vuData', { Set: 'none' });
        this.enableVU = true;   // true: Enable VU calculation
        this.channels = 1;      // Audio channels
        this.bitDepth = 16;     // Audio bit depth
        this.sampleRate = 44100;// Audio sample rate
        this.ready = false;     // Ready indication to be set by implementing class when internal processes are running and the module is ready for linking to other modules. This should include e.g. PulseAudio modules, so the implementing control should check if the PulseAudio module exists before setting 'ready' to true.
        this.SetAccess('ready', { Get: 'none', Set: 'none' });
        this.volume = 100;      // Requested volume in %
        this.maxVolume = 150;   // Maximum permissible volume
        this.run = false        // Run command to be set by external code to request the control to start.
        this.SetAccess('run', { Get: 'none', Set: 'none' });
        this.runVU = false;     // VU meter run command - this should not be set from external code
        this.SetAccess('runVU', { Get: 'none', Set: 'none' });
        this._setVolTimer;      // Timer for rate limiting _setVolume actions
        this.enableVolControl = false;
        this.SetAccess('enableVolControl', { Set: 'none', Get: 'none'});
        this.reload = false;    // Reload configuration command. Stops and starts the control to apply changes.
    }

    Init() {
        // Set PulseAudio Module name
        this._paModuleName = 'MR_PA_' + this._controlName;
        
        // Mute all other modules (with the same parent) in the solo group
        this.on('mute', mute => {
            if (!mute && this.soloGroup) {
                Object.values(this._parent._controls).filter(c => c.soloGroup == this.soloGroup).forEach(m => {
                    if (m._controlName != this._controlName && !m.mute) m.mute = true;
                });
            }
        }, { immediate: true });

        // Start / stop the VU meter
        this.on('runVU', run => {
            if (run) {
                this._startVU();
                this._vuInterval = setInterval(() => {
                    let vu = [...this._vu];

                    let notify = false;
                    if (this._vuPrev.length != vu.length) {
                        notify = true;
                    }

                    for (let i = 0; i < vu.length; i++) {
                        // volume in fraction of 1
                        // vu[i] = Math.round(vu[i] / 32768 * 100) / 100;

                        // volume in dB
                        vu[i] = Math.round(20 * Math.log10(vu[i] / 32768));

                        // Rate limit graph decline
                        if (vu[i] < this._vuPrev[i] - 5) vu[i] = this._vuPrev[i] - 5;

                        // Clamp at -60 db
                        if (vu[i] < -60) vu[i] = -60;

                        // Check if value changed
                        if (!notify) {
                            notify = (vu[i] !== this._vuPrev[i]);
                        }
                    }

                    if (notify) {
                        this._notify({ vuData: vu });   // Notifies with through _topLevelParent.on('data', data => {});
                    }

                    this._vuPrev = [...vu]; // create a shallow copy of the internal VU array
                    this._vuResetPeak = true;
                }, this.vuInterval);
            } else {
                this._stopVU();
                clearInterval(this._vuInterval);
                // Clear vu meter indication
                for (let i = 0; i < this._vu.length; i++) {
                    this._vu[i] = -60;
                }

                this._notify({ vuData: this._vu });
                this._vuPrev = [...this._vu]; // create a shallow copy of the internal VU array
            }
        });

        this.on('run', run => {
            this.runVU = this.run && this.ready && this.enableVU;
            this.enableVolControl = this.run && this.ready;
        }, { immediate: true });

        this.on('ready', ready => {
            this.runVU = this.run && this.ready && this.enableVU;
            this.enableVolControl = this.run && this.ready;
        }, { immediate: true });

        this.on('enableVU', () => {
            this.runVU = this.run && this.ready && this.enableVU;
        }, { immediate: true });

        // Start volume and mute event handlers
        this.on('enableVolControl', enable => {
            let _volEventHandler;
            let _muteEventHandler;
            if (enable) {
                _volEventHandler = this.on('volume', volume => {
                    this._setVolume(volume);
                }, { immediate: true });

                _muteEventHandler = this.on('mute', mute => {
                    this._setMute(mute)
                }, { immediate: true });
            } else if (_volEventHandler && _muteEventHandler) {
                this.off('volume', _volEventHandler);
                this.off('mute', _muteEventHandler);
            }
        });

        // Stop control on removal
        this.on('remove', () => {
            this.ready = false;
            this.run = false;
        });

        // Subscribe to parent (router) run command
        this._parent.on('runCmd', run => {
            this.run = run;
        }, { immediate: true, caller: this });

        // Restart control on reload command
        this.on('reload', reload => {
            if (reload) {
                if (this._parent.runCmd) {
                    this.run = false;
                    setTimeout(() => {
                        this.run = this._parent.runCmd;
                    }, 1000);
                }
            }
            this.reload = false;
        });
    }

    _startVU() {
        if (this.monitor && !this._vuProc) {
            let args = `--record --device ${this.monitor} --format s16le --fix-channels --fix-rate --latency-msec 100 --volume 65536 --raw`; // record at normal rate. Lowering the rate does not keep peak values, so not useful for level indication where peak volumes should be calculated.
            this._vuProc = spawn('pacat', args.split(' '));
            this._parent._log("INFO", `${this._controlName} (${this.displayName}): Starting VU`);
            this._vuProc.stdout.on('data', buffer => {
                // Set VU array to channel count
                this._vu = new Array(this.channels).fill(0);

                if (this.channels > 0) {
                    // Store peak volumes
                    for (let i = 0; i < buffer.length - 1; i += 2) { // skip to next 16bit sample (2 * 8bit)
                        let v = Math.abs(buffer.readInt16LE(i));
                        let channel = i / 2 % this.channels;

                        if (this._vu[channel] < v || this._vuResetPeak) this._vu[channel] = v;
                    }
                    this._vuResetPeak = false;
                }
            });

            this._vuProc.stderr.on('data', data => {
                this._parent._log('ERROR', data.toString());
            });

            this._vuProc.on('close', code => {

            });

            this._vuProc.on('error', err => {

            });
        }
    }

    _stopVU() {
        if (this._vuProc) {
            try {
                this._vuProc.kill('SIGTERM');
                this._vuProc.kill('SIGKILL');
            } catch (err) {

            }
            this._vuProc = undefined;
        }
    }

    /**
     * Set source or sink mute
     * @param {boolean} mute - true = mute; false = unmute
     */
    _setMute(mute) {
        let m;
        if (mute) {
            m = '1';
        } else {
            m = '0';
        }

        let type;
        if (this.source) {
            type = 'source';
        } else if (this.sink) {
            type = 'sink';
        }

        let cmd = `pactl set-${type}-mute ${this[type]} ${m}`;
        exec(cmd, { silent: true }).then(data => {
            if (data.stderr) {
                this._parent._log('ERROR', `${this._paModuleName} (${this.displayName}): ${data.stderr.toString()}`);
            }
        }).catch(err => {
            this._parent._log('FATAL', `${this._paModuleName} (${this.displayName}): ${err.message}`);
        });
    }

    /**
     * Set source or sink volume
     */
    _setVolume(volume) {
        if (!this._setVolTimer) {
            let type;
            if (this.source) {
                type = 'source';
            } else if (this.sink) {
                type = 'sink';
            }

            let cmd = `pactl set-${type}-volume ${this[type]} ${volume}%`;
            exec(cmd, { silent: true }).then(data => {
                if (data.stderr) {
                    this._parent._log('ERROR', `${this._paModuleName} (${this.displayName}): ${data.stderr.toString()}`);
                }
            }).catch(err => {
                this._parent._log('FATAL', `${this._paModuleName} (${this.displayName}): ${err.message}`);
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