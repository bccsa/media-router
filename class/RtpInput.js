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
        this.name = 'New RTP Input';   // Display name
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
                this._ffmpeg = spawn('ffmpeg', args.split(" "));

                // Handle stderr
                this._ffmpeg.stderr.on('data', data => {
                    // parse ffmpeg output here
                });

                this.stdout = this._ffmpeg.stdout;

                // Handle process exit event
                this._ffmpeg.on('close', code => {
                    this._log.emit('log', `ffmpeg input ${this.rtpIP}:${this.rtpPort}: Closed (${code})`);
                    if (!this._exitFlag) {
                        // Restart after 1 second
                        setTimeout(() => { this.Start(); }, 1000);
                    }
                });

                // Handle process error events
                this._ffmpeg.on('error', code => {
                    this._log.emit('log', `ffmpeg input ${this.rtpIP}:${this.rtpPort}: Error ${code}`);
                });
            }
            catch (err) {
                this._log.emit('log', `ffmpeg input ${this.rtpIP}:${this.rtpPort}: ${err.message}`);
            }
        }
    }

    // Stop the input capture process
    Stop() {
        if (this._ffmpeg != undefined) {
            this.stdout = undefined;
            this._exitFlag = true;   // prevent automatic restarting of the process
            this._log.emit('log', `ffmpeg input ${this.rtpIP}:${this.rtpPort}: Stopping ffmpeg...`);
            this._ffmpeg.kill('SIGTERM');
    
            // ffmpeg stops on SIGTERM, but does not exit.
            // Send SIGKILL to quit process
            this._ffmpeg.kill('SIGKILL');

            this._ffmpeg = undefined;
        }
    }
}

// Export class
module.exports.RtpInput = RtpInput;