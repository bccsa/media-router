let _paAudioSourceBase = require('./_paAudioSourceBase');
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const { spawn } = require('child_process');

/**
 * PulseAudio Pipe Source base module.
 */
class _paPipeSourceBase extends _paAudioSourceBase {
    constructor() {
        super();
        this._paModuleID;           // PulseAudio module instance ID
        this._drain;
        this._pipename;             // 'named pipe' file path. This can be used by implementing classes to pipe data into the PulseAudio pipe-source
        this.pipe_ready = false;    // Flag used to indicate that FIFO named pipe is ready
        this.SetAccess('pipe_ready', { Get: 'none', Set: 'none' });
    }

    Init() {
        super.Init();

        this.on('run', run => {
            if (run) {
                this._startPipeSource();
            } else {
                this._stopDrain();
                this._stopPipeSource();
            }
        });

        // listen for pipe creation
        this._parent.on('sources', sources => {
            if (sources.find(t => t.name == this._controlName)) {
                this.pipe_ready = true;
            } else {
                this.pipe_ready = false;
            }
        });

        // Start the drain when the pipe-source is created
        this.on('pipe_ready', (ready) => {
            if (ready) {
                this._startDrain();
            }
        });
    }

    // Create a PulseAudio Pipe Source module
    _startPipeSource() {
        this._pipename = `/tmp/${this._controlName}_pipe`;

        let cmd = `pactl load-module module-pipe-source source_name=${this._controlName} format=s${this.bitDepth}le rate=${this.sampleRate} channels=${this.channels} file=${this._pipename}`;
        exec(cmd, { silent: true }).then(data => {
            if (data.stderr) {
                console.log(data.stderr.toString());
            }

            if (data.stdout.length) {
                this._paModuleID = data.stdout.toString().trim();
                console.log(`${this._controlName}: Created pipe-source; ID: ${this._paModuleID}`);

                this.source = this._controlName;
                this.monitor = this._controlName; // Monitor source is the same as source for PulseAudio sources.
            }
        }).catch(err => {
            console.log(err.message);
        });
    }

    // Remove PulseAudio module
    _stopPipeSource() {
        this.ready = false;
        if (this._paModuleID) {
            let cmd = `pactl unload-module ${this._paModuleID}`;
            exec(cmd, { silent: true }).then(data => {
                if (data.stderr) {
                    console.log(data.stderr.toString());
                } else {
                    console.log(`${this._controlName}: Removed pipe-source`);
                }

                this._paModuleID = undefined;
            }).catch(err => {
                console.log(err.message);
            });
        }
    }

    // Starts a PulseAudio recording process to keep the 'named pipe' FIFO drained and prevent latency buildup
    _startDrain() {
        if (!this._drain) {
            try {
                let args = `--device=${this._controlName} --rate=${this.sampleRate} --channels=${this.channels} --format=s${this.bitDepth}le --latency=1 --raw /dev/null`;
                this._drain = spawn('parec', args.replace(/\s+/g, ' ').split(" "));

                // Handle stderr
                this._drain.stderr.on('data', data => {
                    console.log(`${this._controlName}: pipe-source drain eror: ${data.toString()}`)
                });

                // Handle stdout
                this._drain.stdout.on('data', data => {
                    console.log(data.toString());
                });

                // Handle process exit event
                this._drain.on('close', code => {
                    if (code != null) { console.log(`${this._controlName}: pipe-source drain stopped (${code})`) }
                    this._stopDrain();
                });

                // Handle process error events
                this._drain.on('error', code => {
                    console.log(`${this._controlName}: pipe-source drain error #${code}`);
                });

                // notify that pipe-source is ready. This can be used by implementing classes to start their processes feeding data to the 'named pipe'
                this.ready = true;
            }
            catch (err) {
                console.log(`${this._controlName}: pipe-source drain error ${err.message}`);
                this._stopDrain();
            }
        }
    }

    _stopDrain() {
        if (this._drain) {
            try {
                this._drain.kill('SIGTERM');
                // this._drain.kill('SIGKILL');
            } catch {

            } finally {
                this._drain = undefined;
            }
        }
    }
}

module.exports = _paPipeSourceBase;