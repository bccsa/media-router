// ======================================
// Hardware Pulse-Code Modulation input
// via ffmpeg
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// External libraries
// -------------------------------------

const { spawn } = require('child_process');
const { _inputDevice } = require('./_inputDevice');

// -------------------------------------
// Class declaration
// -------------------------------------

class ffmpegInput extends _inputDevice {
    constructor(DeviceList) {
        super(DeviceList);
        this.name = 'New ffmpeg input'; 
        this.device = 'pulse';
        this._ffmpeg = undefined;
    }

    // Start the input capture process
    Start() {
        this._exitFlag = false;   // Reset the exit flag
        if (this._ffmpeg == undefined) {
            try {
                let args = `-hide_banner -probesize 32 -analyzeduration 0 -fflags nobuffer -flags low_delay -f alsa -thread_queue_size 512 -ac ${this.channels} -sample_rate ${this.sampleRate} -i ${this.device} -c:a pcm_s${this.bitDepth}le -ac ${this.channels} -sample_rate ${this.sampleRate} -f s${this.bitDepth}le -`;
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
}

// Export class
module.exports.ffmpegInput = ffmpegInput;