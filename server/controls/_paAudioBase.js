const { clearInterval } = require('timers');
let { dm } = require('../modular-dm');
const { spawn } = require('child_process');

/**
 * Base class for PulseAudio sources and sinks.
 * Implementing classes should be self-sufficient and should be able to start/stop without relying on other classes' ready or running status'.
 */
class _paAudioBase extends dm {
    constructor() {
        super();
        this.displayName = "";  // Display name
        this.soloGroup = "";
        this.active = false;    // false: mute; true: unmuted / active
        this.showVolumeControl = true;
        this.showMuteControl = true;
        this.displayOrder = 0;  // display order on client interface
        this.clientControl = "client_AudioInputDevice";
        this.monitor = "";      // PulseAudio monitor source
        this.SetAccess('monitor', { Set: 'none' });
        this._vuProc;           // external process for VU meter
        this._vu = [];          // internal vu array
        this._vuInterval;       // VU indication interval timer
        this._vuResetPeak = false;
        this.vuInterval = 100;  // VU meter indication interval in milliseconds
        this.vu = [];           // VU indication per channel (0 - 100%)
        this.enableVU = true;   // true: Enable VU calculation
        this.SetAccess('vu', { Set: 'none' });
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
    }

    Init() {
        // Mute all other modules (with the same parent) in the solo group
        this.on('active', active => {
            if (active && this.soloGroup) {
                Object.values(this._parent.controls).filter(c => c.soloGroup == this.soloGroup).forEach(m => {
                    if (m.name != this.name && m.active) m.active = false;
                });
            }
        }, { immediate: true });

        // Start / stop the VU meter
        this.on('runVU', run => {
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

        this.on('run', () => {
            this.runVU = this.run && this.ready && this.enableVU;
        }, { immediate: true });

        this.on('ready', () => {
            this.runVU = this.run && this.ready && this.enableVU;
        }, { immediate: true });

        this.on('enableVU', () => {
            this.runVU = this.run && this.ready && this.enableVU;
        }, { immediate: true });

        // Stop control on removal
        this.on('remove', () => {
            this.ready = false;
            this.run = false;
        });

        // Subscribe to parent (router) run events
        this._parent.on('run', run => {
            this.run = run;
        }, { immediate: true, caller: this });
    }

    _startVU() {
        if (this.monitor && !this._vuProc) {
            let args = `--device ${this.monitor} --format s16le --fix-channels --fix-rate --latency-msec 100 --volume 65536 --raw`; // --rate 100 does not keep peak values, so not useful for VU applications
            this._vuProc = spawn('parec', args.split(' '));
            console.log(this._controlName + ': Starting VU')
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
                console.error(data.toString());
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
}

module.exports = _paAudioBase;