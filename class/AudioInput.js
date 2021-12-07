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
const { _inputAudioDevice } = require('./_inputAudioDevice');

// -------------------------------------
// Class declaration
// -------------------------------------

class AudioInput extends _inputAudioDevice {
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
            this._logEvent('Starting ffmpeg...');
            try {
                let args = `-hide_banner -probesize 32 -analyzeduration 0 -fflags nobuffer -flags low_delay -f alsa -thread_queue_size 512 -ac ${this.channels} -sample_rate ${this.sampleRate} -i ${this.device} -c:a pcm_s${this.bitDepth}le -ac ${this.channels} -sample_rate ${this.sampleRate} -f s${this.bitDepth}le -`;
                this._ffmpeg = spawn('ffmpeg', args.split(" "));
                this.stdout = this._ffmpeg.stdout;
    
                // Handle stderr
                this._ffmpeg.on('stderr', (data) => {
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
                this._ffmpeg.on('error', error => {
                    this.isRunning = false;
                    if (!error.message.includes('ffmpeg was killed with signal SIGKILL')) {
                        this._logEvent(error.message);
                    }
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

        if (this._ffmpeg != undefined) {
            this._logEvent(`Stopping ffmpeg...`);
            this.isRunning = false;
            this._ffmpeg.kill('SIGTERM');
            this._ffmpeg.kill('SIGKILL');
        }
    }
}

// Export class
module.exports.AudioInput = AudioInput;