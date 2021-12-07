// ======================================
// Hardware Pulse-Code Modulation input
// via arecord
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// External libraries
// -------------------------------------

const { spawn } = require('child_process');
const { _inputDevice } = require('./_inputDevice');

// -------------------------------------
// Class declaration
// -------------------------------------

class AlsaInput extends _inputDevice {
    constructor(DeviceList) {
        super(DeviceList);
        this.name = 'New Alsa Input';       // Display name
        this.format = 'S16_LE';             // For valid formats, see arecord
        this.device = 'Microphone';         // Device name - see arecord -L
        this.buffer = 50000;                // Buffer in microseconds
        this._arecord = undefined;          // arecord process
    }

    // Start the capture process
    Start() {
        this._exitFlag = false;   // Reset the exit flag
        if (this._arecord == undefined) {
            try {
                let args = `--nonblock -D plughw:CARD=${this.device},DEV=0 -c ${this.channels} -r ${this.sampleRate} -f ${this.format} -B ${this.buffer}`;
                this._arecord = spawn('arecord', args.split(" "));
                this.stdout = this._arecord.stdout;

                // Handle stderr
                this._arecord.stderr.on('data', (data) => {
                    this._logEvent(`${data.toString()}`);
                });

                // Handle process exit event
                this._arecord.on('close', code => {
                    this.isRunning = false;
                    this._logEvent(`Closed (${code})`);

                    // Restart after 1 second
                    setTimeout(() => {
                        if (!this._exitFlag) {
                            this._logEvent(`Restarting arecord...`);
                            this.Start();
                        }
                    }, 1000);

                    this._arecord = undefined;
                });

                // Handle process error events
                this._arecord.on('error', code => {
                    this.isRunning = false;
                    this._logEvent(`Error "${code}"`);
                });

                this.isRunning = true;
            }
            catch (err) {
                this.isRunning = false;
                this._logEvent(`${err.message}`);
            }
        }
    }

    // Stop the capture process
    Stop() {
        this._exitFlag = true;   // prevent automatic restarting of the process

        if (this._arecord != undefined) {
            this.stdout = undefined;
            this._logEvent(`Stopping arecord...`);
            this._arecord.kill('SIGTERM');

            // Send SIGKILL to quit process
            this._arecord.kill('SIGKILL');
        }
    }
}

// Export class
module.exports.AlsaInput = AlsaInput;