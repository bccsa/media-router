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

class HwOutput {
    constructor() {
        this.format = 'S16_LE';             // For valid formats, see aplay
        this.sampleRate = 48000;            // PCM sample rate
        this.channels = 1;                  // Channel count
        this.device = 'Headphones';         // Device name - see aplay -L
        this.buffer = 50000;                // Buffer in microseconds
        this.stdin = undefined;             // stdin mapped to aplay process stdin
        this.log = new events.EventEmitter();
        this.aplay = undefined;             // aplay process
        this.exitFlag = false;              // flag used to prevent restarting of the process on normal stop
    }

    // public properties
    get Log() {
        return this.log;
    }

    // Start the playback process
    Start() {
        this.exitFlag = false;   // Reset the exit flag
        if (this.aplay == undefined) {
            try {
                //let args = `-v --nonblock -D plughw:CARD=${this.device},DEV=0 -c ${this.channels} -r ${this.sampleRate} -f ${this.format} -B ${this.buffer} --buffer-size 256 --period-size 128 -`;
                let args = `--nonblock -D plughw:CARD=${this.device},DEV=0 -c ${this.channels} -r ${this.sampleRate} -f ${this.format} -B ${this.buffer} --buffer-size 1024 --period-size 512 -`;
                this.aplay = spawn('aplay', args.split(" "));
                this.stdin = this.aplay.stdin;
    
                // Handle stderr
                this.aplay.stderr.on('data', (data) => {
                    this.log.emit('log', `aplay (${this.device}): ${data.toString()}`); 
                });

                // Handle stdout
                this.aplay.stdout.on('data', (data) => {
                    this.log.emit('log', `aplay (${this.device}): ${data.toString()}`); 
                });

                // Handle process exit event
                this.aplay.on('close', code => {
                    if (!this.exitFlag) {
                        this.log.emit('log', `aplay (${this.device}): Closed (${code})`);  
                        // Restart after 1 second
                        setTimeout(() => {
                            this.log.emit('log', `aplay (${this.device}): Restarting aplay...`);  
                            this.Start();
                        }, 1000);
                    }
                });

                // Handle process error events
                this.aplay.on('error', code => {
                    this.log.emit('log', `aplay (${this.device}): Error ${code}`);    
                });
            }
            catch (err) {
                this.log.emit('log', `aplay (${this.device}): ${err.message}`);
            }
        }
    }

    // Stop the playback process
    Stop() {
        if (this.aplay != undefined) {
            this.exitFlag = true;   // prevent automatic restarting of the process
            this.log.emit('log', `aplay (${this.device}): Stopping aplay...`);
            this.aplay.kill('SIGTERM');

            // Send SIGKILL to quit process
            this.aplay.kill('SIGKILL');
        }
    }
}

// Export class
module.exports.HwOutput = HwOutput;