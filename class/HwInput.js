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

class HwInput {
    constructor() {
        this.format = 'S16_LE';             // For valid formats, see arecord
        this.sampleRate = 48000;            // PCM sample rate
        this.channels = 1;                  // Channel count
        this.device = 'Microphone';         // Device name - see arecord -L
        this.buffer = 50000;                // Buffer in microseconds
        this.stdout = undefined;            // stdout mapped to arecord process stdout
        this.log = new events.EventEmitter();
        this.arecord = undefined;           // arecord process
        this.exitFlag = false;              // flag used to prevent restarting of the process on normal stop
    }

    // public properties
    get Log() {
        return this.log;
    }

    // Start the capture process
    Start() {
        this.exitFlag = false;   // Reset the exit flag
        if (this.arecord == undefined) {
            try {
                let args = `--nonblock -D plughw:CARD=${this.device},DEV=0 -c ${this.channels} -r ${this.sampleRate} -f ${this.format} -B ${this.buffer}`;
                this.arecord = spawn('arecord', args.split(" "));
                this.stdout = this.arecord.stdout;

                // Handle stderr
                this.arecord.stderr.on('data', (data) => {
                    this.log.emit('log', `arecord (${this.device}): ${data.toString()}`); 
                });

                // Handle process exit event
                this.arecord.on('close', code => {
                    if (!this.exitFlag) {
                        this.log.emit('log', `arecord (${this.device}): Closed (${code})`);  
                        // Restart after 1 second
                        setTimeout(() => {
                            this.log.emit('log', `arecord (${this.device}): Restarting arecord...`);  
                            this.Start();
                        }, 1000);
                    }
                });

                // Handle process error events
                this.arecord.on('error', code => {
                    this.log.emit('log', `arecord (${this.device}): Error ${code}`);    
                });
            }
            catch (err) {
                this.log.emit('log', `arecord (${this.device}): ${err.message}`);
            }
        }
    }

    // Stop the capture process
    Stop() {
        if (this.arecord != undefined) {
            this.exitFlag = true;   // prevent automatic restarting of the process
            this.log.emit('log', `arecord (${this.device}): Stopping arecord...`);
            this.arecord.kill('SIGTERM');

            // Send SIGKILL to quit process
            this.arecord.kill('SIGKILL');
        }
    }
}

// Export class
module.exports.HwInput = HwInput;