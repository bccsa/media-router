// ======================================
// Hardware Pulse-Code Modulation input
// via ffmpeg
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// External libraries
// -------------------------------------

const ffmpeg = require('fluent-ffmpeg');
const { _inputDevice } = require('./_inputDevice');

// -------------------------------------
// Class declaration
// -------------------------------------

class AudioInput extends _inputDevice {
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
                var inputOptions = [
                    '-probesize 32',
                    '-analyzeduration 0',
                    '-fflags nobuffer',
                    '-flags low_delay',
                    '-thread_queue_size 512',
                    `-ac ${this.channels}`,
                    `-sample_rate ${this.sampleRate}`,
                ];
                this._ffmpeg = ffmpeg()
                    .input(this.device)
                    .inputFormat('alsa')
                    .inputOptions(inputOptions)
                    .outputFormat(`s${this.bitDepth}le`)
                    .audioCodec(`pcm_s${this.bitDepth}le`)
                    .audioChannels(this.channels)
                    .audioFrequency(this.sampleRate);
    
                // Handle stderr
                this._ffmpeg.on('stderr', (data) => {
                    // this._logEvent(`${data.toString()}`);
                });

                // Handle process exit event
                this._ffmpeg.on('end', code => {
                    this.isRunning = false;
                    this._logEvent(`Closed (${code})`);

                    // Restart after 1 second
                    setTimeout(() => {
                        if (!this._exitFlag) {
                            this._logEvent(`Restarting ffmpeg...`);
                            this.Start();
                        }
                    }, 1000);
                });

                // Handle process error events
                this._ffmpeg.on('error', error => {
                    this.isRunning = false;
                    if (!error.message.includes('ffmpeg was killed with signal SIGKILL')) {
                        this._logEvent(error.message);
                    }
                });

                // Start ffmpeg
                this._logEvent('Starting ffmpeg...');
                this.stdout = this._ffmpeg.pipe();
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

        if (this._ffmpeg != undefined) {
            this.isRunning = false;
            this._logEvent(`Stopping ffmpeg...`);
            this._ffmpeg.kill();
            this._ffmpeg = undefined;
        }
    }
}

// Export class
module.exports.AudioInput = AudioInput;