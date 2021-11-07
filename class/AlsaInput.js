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
const events = require('events');

// -------------------------------------
// Class declaration
// -------------------------------------

class AlsaInput {
    constructor() {
        this.name = 'New Alsa Input';       // Display name
        this.format = 'S16_LE';             // For valid formats, see arecord
        this.sampleRate = 48000;            // PCM sample rate
        this.channels = 1;                  // Channel count
        this.device = 'Microphone';         // Device name - see arecord -L
        this.buffer = 50000;                // Buffer in microseconds
        this.stdout = undefined;            // stdout mapped to arecord process stdout
        this._log = new events.EventEmitter();
        this._arecord = undefined;          // arecord process
        this._exitFlag = false;             // flag used to prevent restarting of the process on normal stop
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
                    this._log.emit('log', `arecord (${this.device}): ${data.toString()}`); 
                });

                // Handle process exit event
                this._arecord.on('close', code => {
                    if (!this._exitFlag) {
                        this._log.emit('log', `arecord (${this.device}): Closed (${code})`);  
                        // Restart after 1 second
                        setTimeout(() => {
                            this._log.emit('log', `arecord (${this.device}): Restarting arecord...`);  
                            this._arecord = undefined;
                            this.Start();
                        }, 1000);
                    }
                });

                // Handle process error events
                this._arecord.on('error', code => {
                    this._log.emit('log', `arecord (${this.device}): Error ${code}`);    
                });
            }
            catch (err) {
                this._log.emit('log', `arecord (${this.device}): ${err.message}`);
            }
        }
    }

    // Stop the capture process
    Stop() {
        if (this._arecord != undefined) {
            this.stdout = undefined;
            this._exitFlag = true;   // prevent automatic restarting of the process
            this._log.emit('log', `arecord (${this.device}): Stopping arecord...`);
            this._arecord.kill('SIGTERM');

            // Send SIGKILL to quit process
            this._arecord.kill('SIGKILL');
        }
    }
}

// Export class
module.exports.AlsaInput = AlsaInput;