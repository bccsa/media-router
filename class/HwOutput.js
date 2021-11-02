// ======================================
// Hardware Pulse-Code Modulation output
// via ffplay
//
// Copyright BCC South Africa
// =====================================

// Set DISPLAY environmental variable to allow FFPlay to display on Display 0
process.env['DISPLAY'] = ':0'

// -------------------------------------
// External libraries
// -------------------------------------

const { spawn } = require('child_process');
const events = require('events');

// -------------------------------------
// Global variables
// -------------------------------------

var ffplay;

// -------------------------------------
// Class declaration
// -------------------------------------

class HwOutput {
    constructor() {
        this.inputFormat = 's16le';
        this.stdin = undefined;
        this.log = new events.EventEmitter();
    }

    // public properties
    get Log() {
        return this.log;
    }

    // Start the playback process
    Start() {
        if (ffplay == undefined) {
            try {
                let args = `-hide_banner -fflags nobuffer -f ${this.inputFormat} -i -`;
                ffplay = spawn('ffplay', args.split(" "));
                this.stdin = ffplay.stdin;
    
                // Handle stderr
                ffplay.stderr.on('data', (data) => {
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
        if (ffplay != undefined) {
            this.log.emit(`ffplay: Stopping ffplay...`);
            ffplay.kill('SIGTERM');

            // Send SIGKILL to quit process
            ffplay.kill('SIGKILL');
        }
    }
}

// Export class
module.exports.HwOutput = HwOutput;