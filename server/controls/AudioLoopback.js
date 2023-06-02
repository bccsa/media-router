let { dm } = require('../modular-dm');
const util = require('util');
const exec = util.promisify(require('child_process').exec);

/**
 * PulseAudio Loopback module. This control connects a PulseAudio source to a PulseAudio sink
 */
class AudioLoopback extends dm {
    constructor() {
        super();
        this.source = "";   // PulseAudio module-loopback source
        this.sink = "";     // PulseAudio module-loopback sink
        this.channels = 1;  // Requested PulseAudio module-loopback channel count
        this.latency = 1;   // Requested PulseAudio module-loopback latency in ms
        this._paModuleID;   // PulseAudio module instance ID
        this.run = false;   // Set to true to start; Set to false to stop;
    }

    Init() {
        this.on('run', run => {
            if (run) {
                this._startLoopback();
            } else {
                this._stopLoopback();
            }
        });
    }

    // Create a PulseAudio loopback-module linking the source to the sink
    _startLoopback() {
        if (this.source && this.sink) {
            let cmd = `pactl load-module module-loopback source=${this.source} sink=${this.sink} latency_msec=${this.latency} channels=${this.channels}`;
            exec(cmd, { silent: true }).then(data => {
                if (data.stderr) {
                    console.log(data.stderr.toString());
                }

                if (data.stdout.length) {
                    this._paModuleID = data.stdout.toString().trim();
                    console.log(`Connected ${this.source} to ${this.sink}; ID: ${this._paModuleID}`);
                }
            }).catch(err => {
                console.log(err.message);
            });
        }
    }

    // Remove a PulseAudio loopback-module disconnecting the source from the sink
    _stopLoopback() {
        if (this._paModuleID) {
            let cmd = `pactl unload-module ${this._paModuleID}`;
            exec(cmd, { silent: true }).then(data => {
                if (data.stderr) {
                    console.log(data.stderr.toString());
                } else {
                    console.log(`Disconnected ${this.source} from ${this.sink}`);
                }

                this._paModuleID = undefined;
            }).catch(err => {
                console.log(err.message);
            });
        }
    }
}

module.exports = AudioLoopback;