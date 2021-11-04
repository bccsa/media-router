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
                let args = `-hide_banner -fflags nobuffer -flags low_delay -f ${this.inputFormat} -sample_rate ${this.inputSampleRate} -ac ${this.inputChannels} -i - -c:a ${this.outputCodec} -sample_rate ${this.outputSampleRate} -ac ${this.outputChannels} -b:a ${this.outputBitrate}k -f rtp rtp://${this.rtpIP}:${this.rtpPort}`
                this.ffmpeg = spawn('ffmpeg', args.split(" "));

                // Handle stderr
                this.ffmpeg.stderr.on('data', data => {
                    // parse ffmpeg output here
                });

                // Handle stdout
                this.ffmpeg.stdout.on('data', data => {
                    
                });

                // Connect stdin to class stdin
                this.stdin = this.ffmpeg.stdin;

                // Handle process exit event
                this.ffmpeg.on('close', code => {
                    this.log.emit('log', `ffmpeg output ${this.rtpIP}:${this.rtpPort}: Closed (${code})`);
                    if (!this.exitFlag) {
                        // Restart after 1 second
                        setTimeout(() => { this.Start(); }, 1000);
                    }
                });

                // Handle process error events
                this.ffmpeg.on('error', code => {
                    this.log.emit('log', `ffmpeg output ${this.rtpIP}:${this.rtpPort}: Error ${code}`);
                });
            }
            catch (err) {
                this.log.emit('log', `ffmpeg output ${this.rtpIP}:${this.rtpPort}: ${err.message}`);
            }
        }
    }

    // Stop the input capture process
    Stop() {
        if (this.ffmpeg != undefined) {
            this.exitFlag = true;   // prevent automatic restarting of the process
            this.log.emit('log', `ffmpeg output ${this.rtpIP}:${this.rtpPort}: Stopping ffmpeg...`);
            this.ffmpeg.kill('SIGTERM');
    
            // ffmpeg stops on SIGTERM, but does not exit.
            // Send SIGKILL to quit process
            this.ffmpeg.kill('SIGKILL');

            this.ffmpeg = undefined;
        }
    }
}

// Export class
module.exports.RtpOutput = RtpOutput;