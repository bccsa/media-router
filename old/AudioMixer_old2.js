// ======================================
// ffmpeg Audio Mixer
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// External libraries
// -------------------------------------

const ffmpeg = require('fluent-ffmpeg');
const { _inputDevice } = require('./_inputDevice');
const { v4: uuidv4 } = require('uuid');

// -------------------------------------
// Class declaration
// -------------------------------------

class AudioMixer_old2 extends _inputDevice {
    constructor(DeviceList) {
        super(DeviceList);
        this.name = 'New Audio Mixer';
        this.inputs = 2;                // Input count. Inputs are number in1, in2, ... in[n]
        this._ffmpeg = undefined;
        this._pipes = {};               // List of named pipes

        
        setTimeout(() => {
            // Create named pipes
            for (let i = 1; i <= this.inputs; i++) {
                let name = `in${i}`;
                this._createNamedPipe(name);

                if (this._pipes[name] && this._pipes[name].stream) {
                    this[name] = this._pipes[name].stream;
                }
            }
        }, 100);
    }

    // Start the input capture process
    Start() {
        this._exitFlag = false;   // Reset the exit flag
        if (this._ffmpeg == undefined) {
            try {
                let ffmpeg_inputs = '';
                Object.keys(this._pipes).forEach(pipeName => {
                    ffmpeg_inputs += `-i ${this._pipes[pipeName].path} `
                });

                let args = `-hide_banner -probesize 32 -analyzeduration 0 -fflags nobuffer -flags low_delay ${ffmpeg_inputs} -filter_complex amix=inputs=${this.inputs} -c:a pcm_s${this.bitDepth}le -ac ${this.channels} -sample_rate ${this.sampleRate} -f s${this.bitDepth}le -thread_queue_size 512 -`;
                this._ffmpeg = spawn('ffmpeg', args.split(" "));
                this.stdout = this._ffmpeg.stdout;
    
                // Handle stderr
                this._ffmpeg.stderr.on('data', (data) => {
                    this._logEvent(`${data.toString()}`);
                });

                // Handle process exit event
                this._ffmpeg.on('close', code => {
                    this.isRunning = false;
                    this._logEvent(`Closed (${code})`);

                    // Restart after 1 second
                    setTimeout(() => {
                        if (!this._exitFlag) {
                            this._logEvent(`Restarting ffmpeg...`);
                            this.Start();
                        }
                    }, 1000);

                    this._ffmpeg = undefined;
                });

                // Handle process error events
                this._ffmpeg.on('error', code => {
                    this.isRunning = false;
                    this._logEvent(`Error "${code}"`);
                });

                this.isRunning = true;
            }
            catch (err) {
                this.isRunning = false;
                this._logEvent(`${err.message}`);
            }
        }
    }

    // Stop the input capture process
    Stop() {
        this._exitFlag = true;   // prevent automatic restarting of the process

        if (this._ffmpeg) {
            this.stdout = undefined;
            this._logEvent(`Stopping ffmpeg...`);
            this._ffmpeg.kill('SIGTERM');
    
            // ffmpeg stops on SIGTERM, but does not exit.
            // Send SIGKILL to quit process
            this._ffmpeg.kill('SIGKILL');
        }
    }

    // Create a writable named pipe
    _createNamedPipe(pipeName) {
        try {
            // Create pipe object in pipe list
            if (this._pipes[pipeName] == undefined) {
                this._pipes[pipeName] = {
                    path : uuidv4(),
                };
            }

            // Create linux named pipe
            if (!fs.existsSync(this._pipes[pipeName].path)) {
                exec(`mkfifo ${this._pipes[pipeName].path}`);
            }

            // Create writable stream
            this._pipes[pipeName].stream = fs.createWriteStream(`${this._pipes[pipeName].path}`);
        }
        catch (error) {
            this._logEvent(`Unable to create named pipe: ${error.message}`);
        }
    }
}

// Export class
module.exports.AudioMixer_old2 = AudioMixer_old2;