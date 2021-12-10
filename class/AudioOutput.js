// ======================================
// Hardware Pulse-Code Modulation output
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// External libraries
// -------------------------------------

const { spawn } = require('child_process');
const { _outputAudioDevice } = require('./_outputAudioDevice');

// -------------------------------------
// Class declaration
// -------------------------------------

class AudioOutput extends _outputAudioDevice {
    constructor(DeviceList) {
        super(DeviceList);
        this.name = 'New Alsa Output';      // Display name
        this.device = 'default';            // Device name - see aplay -L
        this.bufferSize = 2048;             // ALSA buffer size in bytes
        this._alsa = undefined;             // alsa process
    }

    // Start the playback process
    Start() {
        this._logEvent('Starting aplay...')
        this._exitFlag = false;   // Reset the exit flag
        if (this._alsa == undefined) {
            try {
                let args = `-D ${this.device} -c ${this.channels} -f S${this.bitDepth}_LE -r ${this.sampleRate} --buffer-size=${this.bufferSize}`;
                this._alsa = spawn('aplay', args.split(" "));
                this.stdin = this._alsa.stdin;
    
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
                    this.isRunning = false;
                    this._logEvent(`Closed (${code})`);

                    // Restart after 1 second
                    setTimeout(() => {
                        if (!this._exitFlag) {
                            this._logEvent(`Restarting aplay...`);
                            this.Start();
                        }
                    }, 1000);

                    this._alsa = undefined;
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

    // Stop the playback process
    Stop() {
        this._exitFlag = true;   // prevent automatic restarting of the process

        if (this._alsa != undefined) {
            this.isRunning = false;
            this._logEvent(`Stopping aplay...`);
            this._alsa.kill('SIGTERM');

            // Send SIGKILL to quit process
            this._alsa.kill('SIGKILL');
        }
    }
}

// Export class
module.exports.AudioOutput = AudioOutput;