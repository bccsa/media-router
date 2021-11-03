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
    }

    // public properties
    get Log() {
        return this.log;
    }

    // Start the playback process
    Start() {
        if (this.ffplay == undefined) {
            try {
                let args = `-hide_banner -nodisp -framedrop -fflags nobuffer -f ${this.inputFormat} -i -`;
                this.ffplay = spawn('ffplay', args.split(" "));
                this.stdin = this.ffplay.stdin;
    
                // Handle stderr
                this.ffplay.stderr.on('data', (data) => {
                    // parse ffplay output here
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
            this.log.emit(`ffplay: Stopping ffplay...`);
            this.ffplay.kill('SIGTERM');

            // Send SIGKILL to quit process
            this.ffplay.kill('SIGKILL');
        }
    }
}

// Export class
module.exports.HwOutput = HwOutput;