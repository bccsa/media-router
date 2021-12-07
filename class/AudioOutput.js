// ======================================
// Hardware Pulse-Code Modulation output
// via aplay
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
        this.format = 'S16_LE';             // For valid formats, see _aplay
        this.sampleRate = 48000;            // PCM sample rate
        this.channels = 1;                  // Channel count
        this.device = 'pulse';              // Device name - see _aplay -L
        this.buffer = 50000;                // Buffer in microseconds         // stdin mapped to _aplay process stdin
        this._aplay = undefined;            // _aplay process
    }

    // Start the playback process
    Start() {
        this._logEvent('Starting aplay...')
        this._exitFlag = false;   // Reset the exit flag
        if (this._aplay == undefined) {
            try {
                let args = `--nonblock -D ${this.device} -c ${this.channels} -r ${this.sampleRate} -f ${this.format} -B ${this.buffer} --buffer-size 1024 --period-size 512 -`;
                // let args = `--nonblock -D plughw:CARD=${this.alsaDevice},DEV=0 -c ${this.channels} -r ${this.sampleRate} -f ${this.format} -B ${this.buffer} --buffer-size 1024 --period-size 512 -`;
                this._aplay = spawn('aplay', args.split(" "));
                this.stdin = this._aplay.stdin;
    
                // Handle stderr
                this._aplay.stderr.on('data', (data) => {
                    this._logEvent(`${data.toString()}`);
                });

                // Handle stdout
                this._aplay.stdout.on('data', (data) => {
                    this._logEvent(`${data.toString()}`);
                });

                // Handle process exit event
                this._aplay.on('close', code => {
                    this.isRunning = false;
                    this._logEvent(`Closed (${code})`);

                    // Restart after 1 second
                    setTimeout(() => {
                        if (!this._exitFlag) {
                            this._logEvent(`Restarting aplay...`);
                            this.Start();
                        }
                    }, 1000);

                    this._aplay = undefined;
                });

                // Handle process error events
                this._aplay.on('error', error => {
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

        if (this._aplay != undefined) {
            this.isRunning = false;
            this._logEvent(`Stopping aplay...`);
            this._aplay.kill('SIGTERM');

            // Send SIGKILL to quit process
            this._aplay.kill('SIGKILL');
        }
    }
}

// Export class
module.exports.AudioOutput = AudioOutput;