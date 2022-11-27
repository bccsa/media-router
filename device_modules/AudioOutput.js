// ======================================
// Hardware Pulse-Code Modulation output
//
// Copyright BCC South Africa
// =====================================

const { spawn } = require('child_process');
const _audioOutputDevice = require('./_audioOutputDevice');


/**
 * ALSA Audio Ouput module
 * @extends _audioOutputDevice
 * @property {String} device - ALSA Device name - see aplay -L (Default = default)
 * @property {Number} bufferSize - ALSA buffer size in bytes (Default = 64)
 */
class AudioOutput extends _audioOutputDevice {
    constructor() {
        super();
        this.device = 'default';            // Device name - see aplay -L
        this.bufferSize = 64;               // ALSA buffer size in bytes
        this._alsa = undefined;             // alsa process
    }

    /** 
     * Start the playback process
    */
    _start() {
        this._logEvent('Starting aplay...')
        this._exitFlag = false;   // Reset the exit flag
        if (this._alsa == undefined) {
            try {
                let args = `-D ${this.device} -c ${this.channels} -f S${this.bitDepth}_LE -r ${this.sampleRate} -t raw --buffer-size=${this.bufferSize}`;
                this._alsa = spawn('aplay', args.split(" "));
                this._mixer.pipe(this._alsa.stdin);

                // Handle stderr
                this._alsa.stderr.on('data', (data) => {
                    // this._logEvent(`${data.toString()}`);
                });

                // Handle stdout
                this._alsa.stdout.on('data', (data) => {
                    this._logEvent(`${data.toString()}`);
                });

                // Handle process exit event
                this._alsa.on('close', code => {
                    if (this._alsa) {
                        this.stdin.unpipe(this._alsa.stdin);
                        this._alsa.kill('SIGTERM');
                        this._alsa.kill('SIGKILL');
                        this._alsa = undefined;
                    }

                    this.isRunning = false;
                    if (code != null) { this._logEvent(`Closed (${code})`) }

                    // Restart after 1 second
                    setTimeout(() => {
                        if (!this._exitFlag) {
                            this._logEvent(`Restarting aplay...`);
                            this._start();
                        }
                    }, 1000);
                });

                // Handle process error events
                this._alsa.on('error', error => {
                    this.isRunning = false;
                    this._logEvent(`${error}`);
                });

                this.isRunning = true;
            }
            catch (err) {
                this.isRunning = false;
                this._logEvent(`${err.message}`);
            }
        }
    }

    /**
     * Stop the playback process
     */
    _stop() {
        try {
            this._exitFlag = true;   // prevent automatic restarting of the process

            if (this._alsa) {
                this.stdin.unpipe(this._alsa.stdin);
                this.isRunning = false;
                this._logEvent(`Stopping aplay...`);
                this._alsa.kill('SIGTERM');

                // Send SIGKILL to quit process
                this._alsa.kill('SIGKILL');
            }
        }
        catch (error) {
            this._logEvent(error.message);
        }

    }
}

// Export class
module.exports = AudioOutput;