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
const events = require('events');

// -------------------------------------
// Class declaration
// -------------------------------------

class AlsaOutput {
    constructor() {
        this.name = 'New Alsa Output';  // Display name
        this.format = 'S16_LE';             // For valid formats, see _aplay
        this.sampleRate = 48000;            // PCM sample rate
        this.channels = 1;                  // Channel count
        this.device = 'Headphones';         // Device name - see _aplay -L
        this.buffer = 50000;                // Buffer in microseconds
        this.stdin = undefined;             // stdin mapped to _aplay process stdin
        this._log = new events.EventEmitter();
        this._aplay = undefined;             // _aplay process
        this._exitFlag = false;              // flag used to prevent restarting of the process on normal stop
    }

    get log() {
        return this._log;
    }

    SetConfig(config) {
        Object.getOwnPropertyNames(config).forEach(k => {
            // Only update "public" properties
            if (this[k] != undefined && k[0] != '_' && (typeof k == 'number' || typeof k == 'string')) {
                this[k] = config[k];
            }
        });
    }

    GetConfig() {
        let c = {};
        Object.getOwnPropertyNames(this).forEach(k => {
            // Only return "public" properties
            if (k[0] != '_' && (typeof k == 'number' || typeof k == 'string')) {
                c[k] = this[k];
            }
        });
        return c;
    }

    // Start the playback process
    Start() {
        this._exitFlag = false;   // Reset the exit flag
        if (this._aplay == undefined) {
            try {
                let args = `--nonblock -D plughw:CARD=${this.device},DEV=0 -c ${this.channels} -r ${this.sampleRate} -f ${this.format} -B ${this.buffer} --buffer-size 1024 --period-size 512 -`;
                this._aplay = spawn('aplay', args.split(" "));
                this.stdin = this._aplay.stdin;
    
                // Handle stderr
                this._aplay.stderr.on('data', (data) => {
                    this._log.emit('log', `aplay (${this.device}): ${data.toString()}`); 
                });

                // Handle stdout
                this._aplay.stdout.on('data', (data) => {
                    this._log.emit('log', `aplay (${this.device}): ${data.toString()}`); 
                });

                // Handle process exit event
                this._aplay.on('close', code => {
                    if (!this._exitFlag) {
                        this._log.emit('log', `aplay (${this.device}): Closed (${code})`);  
                        // Restart after 1 second
                        setTimeout(() => {
                            this._log.emit('log', `aplay (${this.device}): Restarting aplay...`);  
                            this.Start();
                        }, 1000);
                    }
                });

                // Handle process error events
                this._aplay.on('error', code => {
                    this._log.emit('log', `aplay (${this.device}): Error ${code}`);    
                });
            }
            catch (err) {
                this._log.emit('log', `aplay (${this.device}): ${err.message}`);
            }
        }
    }

    // Stop the playback process
    Stop() {
        if (this._aplay != undefined) {
            this.stdin = undefined;
            this._exitFlag = true;   // prevent automatic restarting of the process
            this._log.emit('log', `aplay (${this.device}): Stopping aplay...`);
            this._aplay.kill('SIGTERM');

            // Send SIGKILL to quit process
            this._aplay.kill('SIGKILL');
        }
    }
}

// Export class
module.exports.AlsaOutput = AlsaOutput;