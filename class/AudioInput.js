// ======================================
// Hardware Pulse-Code Modulation input
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
        this.name = 'New Alsa input';   // Display name
        this.device = 'default';        // Device name - see arecord -L
        this._alsa = undefined;         // alsa process
        this.bufferSize = 2048;         // ALSA buffer size in bytes
    }

    // Start the input capture process
    Start() {
        this._exitFlag = false;   // Reset the exit flag
        if (this._alsa == undefined) {
            this._logEvent('Starting arecord...');
            try {
                let args = `-D ${this.device} -c ${this.channels} -f S${this.bitDepth}_LE -r ${this.sampleRate} --buffer-size=${this.bufferSize}`;
                // let args = `-hide_banner -probesize 32 -analyzeduration 0 -flags low_delay -thread_queue_size 512 ` +
                //            `-f alsa -ac ${this.channels} -sample_rate ${this.sampleRate} -c:a pcm_s${this.bitDepth}le -i ${this.device} ` +
                //            `-f s${this.bitDepth}le -ac ${this.channels} -sample_rate ${this.sampleRate} -c:a pcm_s${this.bitDepth}le -`;
                this._alsa = spawn('arecord', args.split(" "));
                this.stdout = this._alsa.stdout;
    
                // Handle stderr
                this._alsa.on('stderr', (data) => {
                    this._logEvent(`${data.toString()}`);
                });

                // Handle process exit event
                this._alsa.on('close', code => {
                    this.isRunning = false;
                    this._logEvent(`Closed (${code})`);

                    // Restart after 1 second
                    setTimeout(() => {
                        if (!this._exitFlag) {
                            this._logEvent(`Restarting arecord...`);
                            this.Start();
                        }
                    }, 1000);

                    this._alsa = undefined;
                });

                // Handle process error events
                this._alsa.on('error', error => {
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

        if (this._alsa != undefined) {
            this._logEvent(`Stopping arecord...`);
            this.isRunning = false;
            this._alsa.kill('SIGTERM');
            this._alsa.kill('SIGKILL');
        }
    }
}

// Export class
module.exports.AudioInput = AudioInput;