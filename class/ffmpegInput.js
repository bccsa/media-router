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

class ffmpegInput {
    constructor() {
        this.name = 'New ffmpeg input'; 
        this.hwInput = 'pulse';
        this.inputSampleRate = 48000;
        this.inputChannels = 2;
        this.outputChannels = 1;
        this.outputCodec = 'pcm_s16le';
        this.outputFormat = 's16le';
        this.outputSampleRate = 48000;
        this.stdout = undefined;
        this._log = new events.EventEmitter();
        this._ffmpeg = undefined;
        this._exitFlag = false;      // flag used to prevent restarting of the process on normal stop
    }

    get log() {
        return this._log;
    }

    SetConfig(config) {
        Object.keys(config).forEach(k => {
            // Only update "public" properties excluding stdin and stdout properties
            if (this[k] != undefined && k[0] != '_' && (typeof k == Number || typeof k == String)) {
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

    // Start the input capture process
    Start() {
        if (this._ffmpeg == undefined) {
            this._exitFlag = false;   // Reset the exit flag
            try {

                // +++++++++++++++ _ffmpeg -hide_banner -f alsa -acodec pcm_s32le -ac 2 -ar 44100 -i "hw:1,0" out.wav
                let args = `-hide_banner -probesize 32 -analyzeduration 0 -fflags nobuffer -flags low_delay -f alsa -thread_queue_size 512 -ac ${this.inputChannels} -sample_rate ${this.inputSampleRate} -i ${this.hwInput} -c:a ${this.outputCodec} -ac ${this.outputChannels} -sample_rate ${this.outputSampleRate} -f ${this.outputFormat} -`;
                this._ffmpeg = spawn('ffmpeg', args.split(" "));
                this.stdout = this._ffmpeg.stdout;
    
                // Handle stderr
                this._ffmpeg.stderr.on('data', (data) => {
                    // parse _ffmpeg output here
                });

                // Handle process exit event
                this._ffmpeg.on('close', code => {
                    this._log.emit('log', `ffmpeg ${this.hwInput}: Closed (${code})`);
                    if (!this._exitFlag) {
                        // Restart after 1 second
                        setTimeout(() => { this.Start(); }, 1000);
                    }
                });

                // Handle process error events
                this._ffmpeg.on('error', code => {
                    this._log.emit('log', `ffmpeg ${this.hwInput}: Error ${code}`);
                });
            }
            catch (err) {
                this._log.emit('log', `ffmpeg ${this.hwInput}: ${err.message}`);
            }
        }
    }

    // Stop the input capture process
    Stop() {
        if (this._ffmpeg != undefined) {
            this.stdout = undefined;
            this._exitFlag = true;   // prevent automatic restarting of the process
            this._log.emit('log', `ffmpeg ${this.hwInput}: Stopping ffmpeg...`);
            this._ffmpeg.kill('SIGTERM');
    
            // ffmpeg stops on SIGTERM, but does not exit.
            // Send SIGKILL to quit process
            this._ffmpeg.kill('SIGKILL');

            this._ffmpeg = undefined;
        }
    }
}

// Export class
module.exports.ffmpegInput = ffmpegInput;