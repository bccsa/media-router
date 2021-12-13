// ======================================
// Hardware Pulse-Code Modulation input
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// External libraries
// -------------------------------------

const { spawn } = require('child_process');
const { _audioInputDevice } = require('./_audioInputDevice');

// -------------------------------------
// Class declaration
// -------------------------------------

class AudioInput extends _audioInputDevice {
    constructor(DeviceList) {
        super(DeviceList);
        this.name = 'New Alsa input';   // Display name
        this.device = 'default';        // Device name - see arecord -L
        this._process = undefined;      // alsa/ffmpeg process
        this.bufferSize = 2048;         // ALSA buffer size in bytes
        this._execFile = 'ffmpeg';
    }

    // Start the input capture process
    Start() {
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
                this._process.stdout.pipe(this.stdout);
    
                // Handle stderr
                this._process.on('stderr', (data) => {
                    this._logEvent(`${data.toString()}`);
                });

                // Handle process exit event
                this._process.on('close', code => {
                    this._process.stdout.unpipe(this.stdout);
                    this.isRunning = false;
                    if (code != null) { this._logEvent(`Closed (${code})`) }

                    this._process.kill('SIGTERM');
                    this._process.kill('SIGKILL');
                    this._process = undefined;

                    // Restart after 1 second
                    setTimeout(() => {
                        if (!this._exitFlag) {
                            this._logEvent(`Restarting ${this._execFile}...`);
                            this.Start();
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
    Stop() {
        try {
            this._exitFlag = true;   // prevent automatic restarting of the process

            if (this._process != undefined) {
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
module.exports.AudioInput = AudioInput;