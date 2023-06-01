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
        this.displayOrder = 0; // display order on client interface
        this.clientControl = "client_AudioInputDevice";
        this.monitor = ""; // PulseAudio monitor source
        this._vuProc;   // external process for VU meter
        this.vu = 0;    // VU indication (0 - 100%)
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
                this.startVU();
            } else {
                this.stopVU();
            }
        });
    }

    startVU() {
        if (this.monitor && !this._vuProc) {
            let args = `--device ${this.monitor} --rate 100 --format s8`;
            this._vuProc = spawn('parec', args.split(' '));

            this._vuProc.stdout.on('data', data => {
                console.log(data);
            });

            this._vuProc.stderr.on('data', data => {

            });

            this._vuProc.on('close', code => {
                // reset the vu meter
                this.vu = 0;
            });

            this._vuProc.on('error', err => {

            });
        }
    }

    stopVU() {
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