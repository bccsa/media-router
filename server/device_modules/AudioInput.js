// =====================================
// Hardware Pulse-Code Modulation input
//
// Copyright BCC South Africa
// =====================================

const { spawn } = require('child_process');
const _audioInputDevice = require('./_audioInputDevice');

/**
 * ALSA Audio Input module
 * @extends _audioInputDevice
 * @property {String} device - ALSA Device name - see aplay -L (Default = default)
 * @property {Number} bufferSize - ALSA buffer size in bytes (Default = 64)
 */
class AudioInput extends _audioInputDevice {
    constructor() {
        super();
        this.device = 'default';
        this._process = undefined;      // alsa process
        this.bufferSize = 64;
        this._execFile = 'arecord';
    }

    // Start the input capture process
    _start() {
        this._exitFlag = false;   // Reset the exit flag
        if (this._process == undefined) {
            this._logEvent(`Starting ${this._execFile}...`);
            try {
                let args;
                if (this._execFile == 'arecord') {
                    args = `-D ${this.device} -c ${this.channels} -f S${this.bitDepth}_LE -r ${this.sampleRate} -t raw --buffer-size=${this.bufferSize}`;
                }
                else if (this._execFile == 'ffmpeg') {
                    args = `-hide_banner -probesize 32 -analyzeduration 0 -flags low_delay ` +
                           `-f alsa -ac ${this.channels} -sample_rate ${this.sampleRate} -c:a pcm_s${this.bitDepth}le -i ${this.device} ` +
                           `-af aresample=async=1000 ` +
                           `-f s${this.bitDepth}le -ac ${this.channels} -sample_rate ${this.sampleRate} -c:a pcm_s${this.bitDepth}le -`;
                }

                this._process = spawn(`${this._execFile}`, args.split(" "));

                this._process.stdout.on('data', data => {
                    this.stdout.write(data);
                });
    
                // Handle stderr
                this._process.on('stderr', (data) => {
                    this._logEvent(`${data.toString()}`);
                });

                // Handle process exit event
                this._process.on('close', code => {
                    if (this._process) {
                        this._process.stdout.unpipe(this.stdout);
                        this._process.kill('SIGTERM');
                        this._process.kill('SIGKILL');
                        this._process = undefined;
                    }

                    this.isRunning = false;
                    if (code != null) { this._logEvent(`Closed (${code})`) }

                    // Restart after 1 second
                    setTimeout(() => {
                        if (!this._exitFlag) {
                            this._logEvent(`Restarting ${this._execFile}...`);
                            this._start();
                        }
                    }, 1000);
                });

                // Handle process error events
                this._process.on('error', error => {
                    this.isRunning = false;
                    if (!error.message.includes(`${this._execFile} was killed with signal SIGKILL`)) {
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
    _stop() {
        try {
            this._exitFlag = true;   // prevent automatic restarting of the process

            if (this._process) {
                this._logEvent(`Stopping ${this._execFile}...`);
                this._process.stdout.unpipe(this.stdout);
                this.isRunning = false;
                this._process.kill('SIGTERM');
                this._process.kill('SIGKILL');
            }
        }
        catch (error) {
            this._logEvent(error.message);
        }
        
    }
}

// Export class
module.exports = AudioInput;