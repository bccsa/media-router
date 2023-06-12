let _paAudioBase = require('./_paAudioBase');
const util = require('util');
const exec = util.promisify(require('child_process').exec);

/**
 * PulseAudio Null Sink. This is used as a base class for virtual inputs and outputs.
 */
class _paNullSinkBase extends _paAudioBase {
    constructor() {
        super();
        this.source = "";   // PulseAudio module-null-sink source name (xxx.monitor)
        this.sink = "";     // PulseAudio module-null-sink sink name
        this.channels = 1;
        this.bitdepth = 16;
        this.sampleRate = 44100;
        this.latency_msec = 1;  // PulseAudio module-null-sink latency (PulseAudio v15+)
        this.description = 'test description';
        this._paModuleID;   // PulseAudio module instance ID
        this.run = false;   // Set to true to start; Set to false to stop;
    }

    Init() {
        super.Init();

        this.source = `${this._controlName}.monitor`;
        this.sink = this._controlName;
        this.monitor = this.source;

        this.on('run', run => {
            if (run) {
                this._startNullSink();
            } else {
                this._stopNullSink();
            }
        });
    }

    // Create a PulseAudio loopback-module linking the source to the sink
    _startNullSink() {
        // let cmd = `pactl load-module module-null-sink sink_name=${this._controlName} format=s${this.bitdepth}le rate=${this.sampleRate} channels=${this.channels} sink_properties="latency_msec=${this.latency_msec},device.description='${this.description}'"`;
        let cmd = `pactl load-module module-null-sink sink_name=${this._controlName} format=s${this.bitdepth}le rate=${this.sampleRate} channels=${this.channels} sink_properties="latency_msec=${this.latency_msec}"`;
        exec(cmd, { silent: true }).then(data => {
            if (data.stderr) {
                console.log(data.stderr.toString());
            }

            if (data.stdout.length) {
                this._paModuleID = data.stdout.toString().trim();
                console.log(`Created null-sink ${this._controlName}; ID: ${this._paModuleID}`);
                this.emit('null-sink-ready');   // notify that the null-sink has been created
            }
        }).catch(err => {
            console.log(err.message);
        });
    }

    // Remove PulseAudio module
    _stopNullSink() {
        if (this._paModuleID) {
            this.emit('null-sink', false);      // notify that the null-sink is about to be removed
            let cmd = `pactl unload-module ${this._paModuleID}`;
            exec(cmd, { silent: true }).then(data => {
                if (data.stderr) {
                    console.log(data.stderr.toString());
                } else {
                    console.log(`Removed null-sink ${this._controlName}`);
                }

                this._paModuleID = undefined;
            }).catch(err => {
                console.log(err.message);
            });
        }
    }
}

module.exports = _paNullSinkBase;