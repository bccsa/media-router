const { clearInterval } = require('timers');
let { dm } = require('../modular-dm');
const { spawn } = require('child_process');

/**
 * Base class for PulseAudio modules
 */
class _paAudioModule extends dm {
    constructor() {
        super();
        this.soloGroup = "";
        this.mute = true;
        this.showVolumeControl = true;
        this.showMuteControl = true;
        this.displayOrder = 0;  // display order on client interface
        this.clientControl = "client_AudioInputDevice";
        this.monitor = "";      // PulseAudio monitor source
        this._vuProc;           // external process for VU meter
        this._vu = [];          // internal vu array
        this._vuInterval;       // VU indication interval timer
        this._vuResetPeak = false;
        this.vuInterval = 100;  // VU meter indication interval in milliseconds
        this.vu = [];           // VU indication per channel (0 - 100%)
        this.channels = 1;      // Input audio channels
    }

    Init() {
        // Mute all other modules (with the same parent) in the solo group
        this.on('mute', mute => {
            if (!mute && this.soloGroup) {
                Object.values(this._parent.controls).filter(c => c.soloGroup == this.soloGroup).forEach(m => {
                    if (m.name != this.name && !m.mute) m.mute = true;
                });
            }
        });

        // Start / stop the VU meter
        this._parent.on('run', run => {
            if (run) {
                this._startVU();
                this._vuInterval = setInterval(() => {
                    // convert to %
                    let vu = [...this._vu];
                    for (let i = 0; i < vu.length; i++) {
                        vu[i] = Math.round(vu[i] / 32768 * 100);
                    }
                    // Only notify if the contents has changed
                    if (this.vu.toString() != vu.toString()) {
                        this.vu = vu;
                    }

                    this._vuResetPeak = true;
                }, this.vuInterval);
            } else {
                this._stopVU();
                clearInterval(this._vuInterval);
                // Clear vu meter indication
                for (let i = 0; i < this._vu.length; i++) {
                    this._vu[i] = 0;
                }
                this.vu = [...this._vu]; // create a shallow copy of the internal VU array
            }
        });
    }

    _startVU() {
        if (this.monitor && !this._vuProc) {
            let args = `--device ${this.monitor} --format s16le`; // --rate 100 does not keep peak values, so not useful for VU applications
            this._vuProc = spawn('parec', args.split(' '));

            this._vuProc.stdout.on('data', buffer => {
                // Set VU array to channel count
                if (this._vu.length < this.channels) {
                    for (let i = 0; i < this.channels - this._vu.length; i++) {
                        this._vu.push(0);
                    }
                }
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
        }
    }
}

module.exports = _paAudioModule;