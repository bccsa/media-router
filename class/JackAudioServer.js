// =====================================
// Jack audio server manager
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// External libraries
// -------------------------------------

const { spawn } = require('child_process');
const { _device } = require('./_device');

// -------------------------------------
// Class declaration
// -------------------------------------

/**
 * Jack Audio server instance manager class
 * @extends _device
 * @property {number} priority - Jack process realtime priority (default = 75)
 * @property {string} device - ALSA device name (see arecord -L for device names) (default = hw:1)
 * @property {number} sampleRate - Audio device sample rate (default = 48000)
 * @property {boolean} duplex - Enable / disable device duplex mode (default = true)
 * @property {number} period - Number of frames between JACK process calls (default = 64)
 * @property {number} nperiods = Number of periods of playback latency (default = 3)
 */
class JackAudioServer extends _device {
    constructor(DeviceList) {
        super(DeviceList);
        this.name = 'New Jack Server Instance';
        this.priority = 75;
        this.device = "hw:1";
        this.sampleRate = 48000;
        this.duplex = true;
        this.period = 64;
        this.nperiods = 3;
    }

    // Start the input capture process
    Start() {
        this._exitFlag = false;   // Reset the exit flag
        if (this._process == undefined) {
            this._logEvent(`Starting jackd...`);
            try {
                let duplexString = "";
                if (this.duplex == true) { duplexString = "-D" }

                let args = `-P ${this.priority} -d alsa -d ${this.device} -r ${this.sampleRate} ${duplexString} -p ${this.period} -n ${this.nperiods}`;

                this._process = spawn(`jackd`, args.split(" "));
    
                // Handle stderr
                this._process.on('stderr', (data) => {
                    this._logEvent(`${data.toString()}`);
                });

                // Handle stdout
                this._process.on('stdout', (data) => {
                    this._logEvent(`${data.toString()}`);
                });

                this._process.on('exit', code => {
                    // this._logEvent(`Exit (${code})`)
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
                            this._logEvent(`Restarting jackd...`);
                            this.Start();
                        }
                    }, 1000);
                });

                // Handle process error events
                this._process.on('error', error => {
                    this.isRunning = false;
                    if (!error.message.includes(`jackd was killed with signal SIGKILL`)) {
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
                this._logEvent(`Stopping jackd...`);
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
module.exports.JackAudioServer = JackAudioServer;