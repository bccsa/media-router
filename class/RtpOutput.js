// ======================================
// PCM to RTP output via ffmpeg
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

class RtpOutput {
    constructor() {
        this.name = 'New RTP Output';   // Display name
        this.rtpIP = '224.0.0.100';
        this.rtpPort = 3000;
        this.inputSampleRate = 48000;
        this.inputFormat = 's16le';
        this.inputChannels = 1;
        this.outputChannels = 1;
        this.outputBitrate = 32; //kbps
        this.outputSampleRate = 48000;
        this.outputCodec = 'libopus';
        this.stdin = undefined;
        this._log = new events.EventEmitter();
        this._ffmpeg = undefined;
        this._exitFlag = false;      // flag used to prevent restarting of the process on normal stop
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

    // Start the input capture process
    Start() {
        if (this._ffmpeg == undefined) {
            this._exitFlag = false;   // Reset the exit flag
            try {
                let args = `-hide_banner -fflags nobuffer -flags low_delay -f ${this.inputFormat} -sample_rate ${this.inputSampleRate} -ac ${this.inputChannels} -i - -c:a ${this.outputCodec} -sample_rate ${this.outputSampleRate} -ac ${this.outputChannels} -b:a ${this.outputBitrate}k -f rtp rtp://${this.rtpIP}:${this.rtpPort}`
                this._ffmpeg = spawn('ffmpeg', args.split(" "));

                // Handle stderr
                this._ffmpeg.stderr.on('data', data => {
                    // parse ffmpeg output here
                });

                // Handle stdout
                this._ffmpeg.stdout.on('data', data => {
                    
                });

                // Connect stdin to class stdin
                this.stdin = this._ffmpeg.stdin;

                // Handle process exit event
                this._ffmpeg.on('close', code => {
                    this._log.emit('log', `ffmpeg output ${this.rtpIP}:${this.rtpPort}: Closed (${code})`);
                    if (!this._exitFlag) {
                        // Restart after 1 second
                        setTimeout(() => { this.Start(); }, 1000);
                    }
                });

                // Handle process error events
                this._ffmpeg.on('error', code => {
                    this._log.emit('log', `ffmpeg output ${this.rtpIP}:${this.rtpPort}: Error ${code}`);
                });
            }
            catch (err) {
                this._log.emit('log', `ffmpeg output ${this.rtpIP}:${this.rtpPort}: ${err.message}`);
            }
        }
    }

    // Stop the input capture process
    Stop() {
        if (this._ffmpeg != undefined) {
            this.stdin = undefined;
            this._exitFlag = true;   // prevent automatic restarting of the process
            this._log.emit('log', `ffmpeg output ${this.rtpIP}:${this.rtpPort}: Stopping ffmpeg...`);
            this._ffmpeg.kill('SIGTERM');
    
            // ffmpeg stops on SIGTERM, but does not exit.
            // Send SIGKILL to quit process
            this._ffmpeg.kill('SIGKILL');

            this._ffmpeg = undefined;
        }
    }
}

// Export class
module.exports.RtpOutput = RtpOutput;