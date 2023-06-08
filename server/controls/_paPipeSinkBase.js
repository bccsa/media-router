let _paAudioSinkBase = require('./_paAudioSinkBase');
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const { pcm_buffer } = require('../modules/pcm_buffer');

/**
 * PulseAudio Pipe Sink base module.
 */
class _paPipeSinkBase extends _paAudioSinkBase {
    constructor() {
        super();
        this._paModuleID;   // PulseAudio module instance ID
        this.buffersize = 1024; // Buffer size in bytes
        this._buffer;       // pcm buffer
        this.pipename = '';
    }

    Init() {
        super.Init();

        this.on('run', run => {
            if (run) {
                this._buffer = new pcm_buffer(this.channels, this.bitdepth, this.buffersize);
                this._startPipeSink();
            } else {
                this._stopPipeSink();
                delete this._buffer;
            }
        });
    }

    // Create a PulseAudio Pipe Sink module
    _startPipeSink() {
        let pipe_name = `/tmp/${this._controlName}_pipe`;
        let cmd = `pactl load-module module-pipe-sink sink_name=${this._controlName} format=s${this.bitdepth}le rate=${this.sampleRate} channels=${this.channels} file=${pipe_name}`;
        exec(cmd, { silent: true }).then(data => {
            if (data.stderr) {
                console.log(data.stderr.toString());
            }

            if (data.stdout.length) {
                this._paModuleID = data.stdout.toString().trim();
                console.log(`Created pipe-sink ${this._controlName}; ID: ${this._paModuleID}`);
                
                // Set pipe name property to notify that pipe is created
                this.pipename = pipe_name;

                // Connect the buffer to the the PulseAudio module's named pipe
                // this._buffer.pipe()
            }
        }).catch(err => {
            console.log(err.message);
        });
    }

    // Remove PulseAudio module
    _stopPipeSink() {
        if (this._paModuleID) {
            this.pipename = '';     // notify that the pipe is about to be removed
            let cmd = `pactl unload-module ${this._paModuleID}`;
            exec(cmd, { silent: true }).then(data => {
                if (data.stderr) {
                    console.log(data.stderr.toString());
                } else {
                    console.log(`Removed pipe-sink ${this._controlName}`);
                }

                this._paModuleID = undefined;
            }).catch(err => {
                console.log(err.message);
            });
        }
    }
}

module.exports = _paPipeSinkBase;