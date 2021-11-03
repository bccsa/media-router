// ======================================
// RTP input via ffmpeg, encoded to PCM
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

class RtpInput {
    constructor() {
        this.rtpIP = '224.0.0.100';
        this.rtpPort = 3000;
        this.inputChannels = 1;
        this.inputBitrate = 32; //kbps
        this.outputSampleRate = 48000;
        this.outputCodec = 'pcm_s16le';
        this.outputFormat = 's16le';
        this.outputChannels = 1;
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
                let sdp =
                `v=0
                o=- 0 0 IN IP4 127.0.0.1
                s=No Name
                c=IN IP4 ${this.rtpIP}
                t=0 0
                a=tool:libavformat 58.20.100
                m=audio ${this.rtpPort} RTP/AVP 97
                b=AS:${this.inputBitrate}
                a=rtpmap:97 opus/48000/${this.inputChannels}`

                let args = `-hide_banner -fflags nobuffer -f rtp -i "data:application/sdp;charset=UTF8,${sdp}" \
                -c:a ${this.outputCodec} -ac ${this.outputChannels} -f ${this.outputFormat} -`;
                this.ffmpeg = spawn('ffmpeg', args.split(" "));
                this.stdout = this.ffmpeg.stdout;
    
                // Handle stderr
                this.ffmpeg.stderr.on('data', data => {
                    // parse ffmpeg output here
                });

                // Handle process exit event
                this.ffmpeg.on('close', code => {
                    // ++++++++++++++++ To do: Restart ffmpeg if stopped ++++++++++++++++++
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
            this.log.emit(`ffmpeg ${this.rtpIP}:${this.rtpPort}: Stopping ffmpeg...`);
            this.ffmpeg.kill('SIGTERM');
    
            // ffmpeg stops on SIGTERM, but does not exit.
            // Send SIGKILL to quit process
            this.ffmpeg.kill('SIGKILL');

            this.ffmpeg = undefined;
        }
    }
}

// Export class
module.exports.RtpInput = RtpInput;