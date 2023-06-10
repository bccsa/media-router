let _paAudioSinkBase = require('./_paAudioSinkBase');
const util = require('util');
const exec = util.promisify(require('child_process').exec);

/**
 * PulseAudio Pipe Sink base module.
 */
class _paPipeSinkBase extends _paAudioSinkBase {
    constructor() {
        super();
        this._paModuleID;   // PulseAudio module instance ID
        this._pipename;     // 'named pipe' file path. This can be used by implementing classes to pipe data fron the PulseAudio pipe-sink
    }

    Init() {
        super.Init();

        this.on('run', run => {
            if (run) {
                this._startPipeSink();
            } else {
                this._stopPipeSink();
            }
        });
    }

    // Create a PulseAudio Pipe Sink module
    _startPipeSink() {
        this._pipename = `/tmp/${this._controlName}_pipe`;
        let cmd = `pactl load-module module-pipe-sink sink_name=${this._controlName} format=s${this.bitDepth}le rate=${this.sampleRate} channels=${this.channels} file=${this._pipename}`;
        exec(cmd, { silent: true }).then(data => {
            if (data.stderr) {
                console.log(data.stderr.toString());
            }

            if (data.stdout.length) {
                this._paModuleID = data.stdout.toString().trim();
                console.log(`${this._controlName}: Created pipe-sink; ID: ${this._paModuleID}`);

                // notify that pipe-sink is ready. This can be used by implementing classes to start their processes feeding data from the 'named pipe'
                this.emit('pipe-sink-ready');
            }
        }).catch(err => {
            console.log(err.message);
        });
    }

    // Remove PulseAudio module
    _stopPipeSink() {
        if (this._paModuleID) {
            let cmd = `pactl unload-module ${this._paModuleID}`;
            exec(cmd, { silent: true }).then(data => {
                if (data.stderr) {
                    console.log(data.stderr.toString());
                } else {
                    console.log(`${this._controlName}: Removed pipe-sink`);
                }

                this._paModuleID = undefined;
            }).catch(err => {
                console.log(err.message);
            });
        }
    }
}

module.exports = _paPipeSinkBase;