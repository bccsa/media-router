// ======================================
// Hardware Pulse-Code Modulation output
// via ffplay
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
        this.name = 'New ffplay output'; 
        this.sampleRate = 48000;
        this.channels = 1;
        this.bitDepth = 16;
        this._ffplay = undefined;
    }

    // Start the playback process
    Start() {
        this._logEvent('Starting ffplay...')
        this._exitFlag = false;   // Reset the exit flag
        if (this._ffplay == undefined) {
            try {
                let args = `-hide_banner -probesize 32 -analyzeduration 0 -sync ext -nodisp -framedrop -fflags nobuffer -ac ${this.channels} -sample_rate ${this.sampleRate} -f s${this.bitDepth}le -i -`;
                this._ffplay = spawn('ffplay', args.split(" "));
                this.stdin = this._ffplay.stdin;
    
                // Handle stderr
                this._ffplay.stderr.on('data', (data) => {
                    // this._logEvent(`${data.toString()}`);
                });

                // Handle stdout
                this._ffplay.stdout.on('data', (data) => {
                    this._logEvent(`${data.toString()}`);
                });

                // Handle process exit event
                this._ffplay.on('close', code => {
                    this.isRunning = false;
                    this._logEvent(`Closed (${code})`);

                    // Restart after 1 second
                    setTimeout(() => {
                        if (!this._exitFlag) {
                            this._logEvent(`Restarting ffplay...`);
                            this.Start();
                        }
                    }, 1000);

                    this._ffplay = undefined;
                });

                // Handle process error events
                this._ffplay.on('error', error => {
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

        if (this._ffplay != undefined) {
            this.isRunning = false;
            this._logEvent(`Stopping ffplay...`);
            this._ffplay.kill('SIGTERM');

            // Send SIGKILL to quit process
            this._ffplay.kill('SIGKILL');
        }
    }
}

// Export class
module.exports.AudioOutput = AudioOutput;