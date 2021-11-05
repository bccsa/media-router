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
        this.hwInput = 'pulse';
        this.inputSampleRate = 48000;
        this.inputChannels = 2;
        this.outputChannels = 1;
        this.outputCodec = 'pcm_s16le';
        this.outputFormat = 's16le';
        this.outputSampleRate = 48000;
        this.stdout = undefined;
        this.log = new events.EventEmitter();
        this.ffmpeg = undefined;
        this.exitFlag = false;      // flag used to prevent restarting of the process on normal stop
    }

    // public properties
    get Log() {
        return this.log;
    }

    // Start the input capture process
    Start() {
        if (this.ffmpeg == undefined) {
            this.exitFlag = false;   // Reset the exit flag
            try {

                // +++++++++++++++ ffmpeg -hide_banner -f alsa -acodec pcm_s32le -ac 2 -ar 44100 -i "hw:1,0" out.wav
                let args = `-hide_banner -probesize 32 -analyzeduration 0 -fflags nobuffer -flags low_delay -f alsa -thread_queue_size 512 -ac ${this.inputChannels} -sample_rate ${this.inputSampleRate} -i ${this.hwInput} -c:a ${this.outputCodec} -ac ${this.outputChannels} -sample_rate ${this.outputSampleRate} -f ${this.outputFormat} -`;
                this.ffmpeg = spawn('ffmpeg', args.split(" "));
                this.stdout = this.ffmpeg.stdout;
    
                // Handle stderr
                this.ffmpeg.stderr.on('data', (data) => {
                    // parse ffmpeg output here
                });

                // Handle process exit event
                this.ffmpeg.on('close', code => {
                    this.log.emit('log', `ffmpeg ${this.hwInput}: Closed (${code})`);
                    if (!this.exitFlag) {
                        // Restart after 1 second
                        setTimeout(() => { this.Start(); }, 1000);
                    }
                });

                // Handle process error events
                this.ffmpeg.on('error', code => {
                    this.log.emit('log', `ffmpeg ${this.hwInput}: Error ${code}`);
                });
            }
            catch (err) {
                this.log.emit('log', `ffmpeg ${this.hwInput}: ${err.message}`);
            }
        }
    }

    // Stop the input capture process
    Stop() {
        if (this.ffmpeg != undefined) {
            this.exitFlag = true;   // prevent automatic restarting of the process
            this.log.emit('log', `ffmpeg ${this.hwInput}: Stopping ffmpeg...`);
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