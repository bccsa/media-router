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
const events = require('events');

// -------------------------------------
// Class declaration
// -------------------------------------

class HwOutput {
    constructor() {
        this.inputFormat = 's16le';
        this.stdin = undefined;
        this.log = new events.EventEmitter();
        this.ffplay = undefined;
        this.exitFlag = false;      // flag used to prevent restarting of the process on normal stop
    }

    // public properties
    get Log() {
        return this.log;
    }

    // Start the playback process
    Start() {
        this.exitFlag = false;   // Reset the exit flag
        if (this.ffplay == undefined) {
            try {
                let args = `-hide_banner -nodisp -framedrop -fflags nobuffer -f ${this.inputFormat} -i -`;
                this.ffplay = spawn('ffplay', args.split(" "));
                this.stdin = this.ffplay.stdin;
    
                // Handle stderr
                this.ffplay.stderr.on('data', (data) => {
                    // parse ffplay output here
                });

                // Handle process exit event
                this.ffplay.on('close', code => {
                    if (!this.exitFlag) {
                        // Restart after 1 second
                        setTimeout(() => { this.Start(); }, 1000);
                    }
                });

                // Handle process error events
                this.ffplay.on('error', code => {
                    
                });
            }
            catch (err) {
                this.log.emit(`ffplay: ${err.message}`);
            }
        }
    }

    // Stop the playback process
    Stop() {
        if (this.ffplay != undefined) {
            this.exitFlag = true;   // prevent automatic restarting of the process
            this.log.emit(`ffplay: Stopping ffplay...`);
            this.ffplay.kill('SIGTERM');

            // Send SIGKILL to quit process
            this.ffplay.kill('SIGKILL');
        }
    }
}

// Export class
module.exports.HwOutput = HwOutput;