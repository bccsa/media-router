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
const fs = require('fs');

// -------------------------------------
// Class declaration
// -------------------------------------

class RtpInput {
    constructor() {
        this.rtpIP = '224.0.0.100';
        this.rtpPort = 3000;
        this.inputChannels = 1;
        this.inputBitrate = 32; //kbps
        this.inputSampleRate = 48000;
        this.outputSampleRate = 48000;
        this.outputCodec = 'pcm_s16le';
        this.outputFormat = 's16le';
        this.outputChannels = 1;
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
                // Write sdp file to disk
                if (!fs.existsSync('sdp')) {
                    fs.mkdirSync('sdp')
                }

                let sdpFile = 'sdp/' + this.rtpIP + "_" + this.rtpPort + ".sdp";
                fs.writeFileSync(sdpFile, `v=0
o=- 0 0 IN IP4 127.0.0.1
s=No Name
c=IN IP4 ${this.rtpIP}
t=0 0
a=tool:libavformat 58.20.100
m=audio ${this.rtpPort} RTP/AVP 97
b=AS:${this.inputBitrate}
a=rtpmap:97 opus/${this.inputSampleRate}/${this.inputChannels}`);

                let args = `-hide_banner -fflags nobuffer -flags low_delay -protocol_whitelist file,udp,rtp -reorder_queue_size 0 -buffer_size 0 -i ${sdpFile} -c:a ${this.outputCodec} -sample_rate ${this.outputSampleRate} -ac ${this.outputChannels} -f ${this.outputFormat} -`
                this.ffmpeg = spawn('ffmpeg', args.split(" "));

                // Handle stderr
                this.ffmpeg.stderr.on('data', data => {
                    // parse ffmpeg output here
                });

                this.stdout = this.ffmpeg.stdout;

                // Handle process exit event
                this.ffmpeg.on('close', code => {
                    if (!this.exitFlag) {
                        // Restart after 1 second
                        setTimeout(() => { this.Start(); }, 1000);
                    }
                });

                // Handle process error events
                this.ffmpeg.on('error', code => {
                    
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
            this.log.emit('log', `ffmpeg ${this.rtpIP}:${this.rtpPort}: Stopping ffmpeg...`);
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