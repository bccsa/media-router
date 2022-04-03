// =====================================
// Hardware JACK Pulse-Code Modulation input
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

/**
 * Jack Audio Input port to PCM stdout
 * @extends _audioInputDevice
 * @property {string} ports - Space delimted list of JACK input ports (run jack_lsp for list of ports) (default = system:capture_1 system:capture_2)
 * @property {string} bufferSize - Buffer size in (default = 256k)
 * @property {string} encoding - Audio encoding format [signed, unsigned, float] (default = signed)
 */
class JackAudioInput extends _audioInputDevice {
    constructor(DeviceList) {
        super(DeviceList);
        this.name = 'New Jack input port';
        this.ports = 'system:capture_1 system:capture_2';
        this._process = undefined;
        this.bufferSize = '256k';
        this.sampleRate = undefined;
        this.encoding = 'signed';
    }

    // Start the input capture process
    Start() {
        this._exitFlag = false;   // Reset the exit flag
        if (this._process == undefined) {
            this._logEvent(`Starting jack-stdout...`);
            try {
                let args = `-S ${this.bufferSize} -b ${this.bitDepth} -e ${this.encoding} ${this.ports}`;

                // Wait for jack server to run
                setTimeout(() => {
                    this._process = spawn(`jack-stdout`, args.split(" "));
                    this._process.stdout.pipe(this.stdout);

                    // Handle stderr
                    this._process.on('stderr', (data) => {
                        this._logEvent(`${data.toString()}`);
                    });

                    this._process.on('exit', code => {
                        this._logEvent(`Exit`)
                    });

                    // Handle process exit event
                    this._process.on('close', code => {
                        if (this._process != undefined) {
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
                                this._logEvent(`Restarting jack-stdout...`);
                                this.Start();
                            }
                        }, 1000);
                    });

                    // Handle process error events
                    this._process.on('error', error => {
                        this.isRunning = false;
                        if (!error.message.includes(`jack-stdout was killed with signal SIGKILL`)) {
                            this._logEvent(error.message);
                        }
                    });

                    this.isRunning = true;
                }, 1000);
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
                this._logEvent(`Stopping jack-stdout...`);
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
module.exports.JackAudioInput = JackAudioInput;