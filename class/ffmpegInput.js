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
const { _device } = require('./_device');

// -------------------------------------
// Class declaration
// -------------------------------------

class ffmpegInput extends _device {
    constructor(DeviceList) {
        super(DeviceList);
        this.name = 'New ffmpeg input'; 
        this.device = 'pulse';
        this.inputSampleRate = 48000;
        this.inputChannels = 2;
        this.outputChannels = 1;
        this.outputCodec = 'pcm_s16le';
        this.outputFormat = 's16le';
        this.outputSampleRate = 48000;
        this.stdout = undefined;
        this._ffmpeg = undefined;
    }

    // Start the input capture process
    Start() {
        this._exitFlag = false;   // Reset the exit flag
        if (this._ffmpeg == undefined) {
            try {
                let args = `-hide_banner -probesize 32 -analyzeduration 0 -fflags nobuffer -flags low_delay -f alsa -thread_queue_size 512 -ac ${this.inputChannels} -sample_rate ${this.inputSampleRate} -i ${this.hwInput} -c:a ${this.outputCodec} -ac ${this.outputChannels} -sample_rate ${this.outputSampleRate} -f ${this.outputFormat} -`;
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

                    if (!this._exitFlag) {
                        // Restart after 1 second
                        setTimeout(() => {
                            this._logEvent(`Restarting ffmpeg...`);
                            this.Start();
                        }, 1000);
                    }

                    this._ffmpeg = undefined;
                });

                // Handle process error events
                this._ffmpeg.on('error', code => {
                    this.isRunning = false;
                    this._logEvent(`Error ${code}`);
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
        if (this._ffmpeg != undefined) {
            this.stdout = undefined;
            this._exitFlag = true;   // prevent automatic restarting of the process
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