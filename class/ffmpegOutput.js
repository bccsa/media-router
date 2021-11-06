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

class ffmpegOutput {
    constructor() {
        this.name = 'New _ffmpeg output'; 
        this.inputFormat = 's16le';
        this.inputSampleRate = 48000;
        this.inputChannels = 1;
        this.stdin = undefined;
        this._log = new events.EventEmitter();
        this._ffplay = undefined;
        this._exitFlag = false;      // flag used to prevent restarting of the process on normal stop
    }

    get type() {
        return this.constructor.name;
    }

    get log() {
        return this._log;
    }

    SetConfig(config) {
        Object.keys(config).forEach(k => {
            // Only update "public" properties excluding stdin and stdout properties
            if (this[k] != undefined && k[0] != '_' && k != 'type' && (typeof k == Number || typeof k == String)) {
                this[k] = config[k];
            }
        });
    }

    GetConfig() {
        let c = {};
        Object.keys(this).forEach(k => {
            // Only return "public" properties
            if (k[0] != '_' && (typeof k == Number || typeof k == String)) {
                c[k] = this[k];
            }
        });
        return c;
    }

    // Start the playback process
    Start() {
        this._exitFlag = false;   // Reset the exit flag
        if (this._ffplay == undefined) {
            try {
                let args = `-hide_banner -probesize 32 -analyzeduration 0 -sync ext -nodisp -framedrop -fflags nobuffer -ac ${this.inputChannels} -sample_rate ${this.inputSampleRate} -f ${this.inputFormat} -i -`;
                this._ffplay = spawn('ffplay', args.split(" "));
                this.stdin = this._ffplay.stdin;
    
                // Handle stderr
                this._ffplay.stderr.on('data', (data) => {
                    // parse ffplay output here
                });

                // Handle process exit event
                this._ffplay.on('close', code => {
                    if (!this._exitFlag) {
                        // Restart after 1 second
                        setTimeout(() => { this.Start(); }, 1000);
                    }
                });

                // Handle process error events
                this._ffplay.on('error', code => {
                    
                });
            }
            catch (err) {
                this._log.emit('log', `ffplay: ${err.message}`);
            }
        }
    }

    // Stop the playback process
    Stop() {
        if (this._ffplay != undefined) {
            this.stdin = undefined;
            this._exitFlag = true;   // prevent automatic restarting of the process
            this._log.emit('log', `ffplay: Stopping ffplay...`);
            this._ffplay.kill('SIGTERM');

            // Send SIGKILL to quit process
            this._ffplay.kill('SIGKILL');
        }
    }
}

// Export class
module.exports.ffmpegOutput = ffmpegOutput;