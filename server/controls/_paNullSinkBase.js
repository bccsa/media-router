let _paAudioSourceBase = require('./_paAudioSourceBase');
const util = require('util');
const exec = util.promisify(require('child_process').exec);

/**
 * PulseAudio Null Sink. This is used as a base class for virtual inputs and outputs.
 */
class _paNullSinkBase extends _paAudioSourceBase {
    constructor() {
        super();
        this.source = "";   // PulseAudio module-null-sink source name (xxx.monitor)
        this.sink = "";     // PulseAudio module-null-sink sink name
        this.channels = 1;
        this.bitDepth = 16;
        this.sampleRate = 44100;
        this.description = 'test description';
        this._paModuleID;   // PulseAudio module instance ID
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

        // listen for null sink creation
        this._parent.on('sinks', sinks => {
            if (sinks.find(t => t.name == this._controlName)) {
                this.ready = true;
            } else {
                this.ready = false;
            }
        });
    }

    // Create a PulseAudio loopback-module linking the source to the sink
    _startNullSink() {
        // let cmd = `pactl load-module module-null-sink sink_name=${this._controlName} format=s${this.bitdepth}le rate=${this.sampleRate} channels=${this.channels} sink_properties="latency_msec=${this.latency_msec},device.description='${this.description}'"`;
        let cmd = `pactl load-module module-null-sink sink_name=${this._controlName} format=s${this.bitDepth}le rate=${this.sampleRate} channels=${this.channels} sink_properties="latency_msec=${this._parent.paLatency}"`;
        exec(cmd, { silent: true }).then(data => {
            if (data.stderr) {
                console.log(data.stderr.toString());
            }

            if (data.stdout.length) {
                this._paModuleID = data.stdout.toString().trim();
                console.log(`${this._controlName} (${this.displayName}): Created null-sink; ID: ${this._paModuleID}`);
            }
        }).catch(err => {
            console.log(err.message);
        });
    }

    // Remove PulseAudio module
    _stopNullSink() {
        if (this._paModuleID) {
            let cmd = `pactl unload-module ${this._paModuleID}`;
            exec(cmd, { silent: true }).then(data => {
                if (data.stderr) {
                    console.log(data.stderr.toString());
                } else {
                    console.log(`${this._controlName} (${this.displayName}): Removed null-sink`);
                }

                this._paModuleID = undefined;
            }).catch(err => {
                console.log(err.message);
            });
        }
    }
}

module.exports = _paNullSinkBase;