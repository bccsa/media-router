// ======================================
// Hardware Pulse-Code Modulation input
// via ffmpeg
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
        this.hwInput = 'hw:1';
        this.sampleRate = 44100;
        this.codec = 'pcm_s16le';
        this.outputFormat = 's16le';
        this.inputChannels = 1;
        this.mixdownChannels = 1;
        this.stdout = undefined;
        this.log = new events.EventEmitter();
        this.ffmpeg = undefined;
    }

    // public properties
    get Log() {
        return this.log;
    }

    // Start the input capture process
    Start() {
        if (this.ffmpeg == undefined) {
            try {
                let args = `-hide_banner -f alsa -thread_queue_size 512 -ac ${this.inputChannels} -sample_rate ${this.sampleRate} -i ${this.hwInput} -c:a ${this.codec} -ac ${this.mixdownChannels} -f ${this.outputFormat} -`;
                this.ffmpeg = spawn('ffmpeg', args.split(" "));
                this.stdout = this.ffmpeg.stdout;
    
                // Handle stderr
                this.ffmpeg.stderr.on('data', (data) => {
                    // parse ffmpeg output here
                });

                // Handle process exit event
                this.ffmpeg.on('close', code => {

                });

                // Handle process error events
                this.ffmpeg.on('error', code => {
                    
                });
            }
            catch (err) {
                this.log.emit(`ffmpeg ${this.hwInput}: ${err.message}`);
            }
        }
    }

    // Stop the input capture process
    Stop() {
        if (this.ffmpeg != undefined) {
            this.log.emit(`ffmpeg ${this.hwInput}: Stopping ffmpeg...`);
            this.ffmpeg.kill('SIGTERM');
    
            // ffmpeg stops on SIGTERM, but does not exit.
            // Send SIGKILL to quit process
            this.ffmpeg.kill('SIGKILL');

            this.ffmpeg = undefined;
        }
    }
}

// Export class
module.exports.HwInput = HwInput;