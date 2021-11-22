// ======================================
// RTP input via ffmpeg, encoded to PCM
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// External libraries
// -------------------------------------

const { spawn } = require('child_process');
const { _inputDevice } = require('./_inputDevice');
const fs = require('fs');

// -------------------------------------
// Class declaration
// -------------------------------------

class RtpInput extends _inputDevice {
    constructor(DeviceList) {
        super(DeviceList);
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
        this._ffmpeg = undefined;
    }

    // Start the input capture process
    Start() {
        this._exitFlag = false;   // Reset the exit flag
        if (this._ffmpeg == undefined) {
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
                this.stdout = this._ffmpeg.stdout;

                // Handle stderr
                this._ffmpeg.stderr.on('data', data => {
                    this._logEvent(`${data.toString()}`);
                });
                
                // Handle process exit event
                this._ffmpeg.on('close', code => {
                    this.isRunning = false;
                    this._logEvent(`Closed (${code})`);

                    if (!this._exitFlag) {
                        // Restart after 1 second
                        setTimeout(() => { 
                            this._logEvent(`Restarting ffmpeg...`);
                            this.Start();
                        }, 1000);
                    }

                    this._ffmpeg = undefined;
                });

                // Handle process error events
                this._ffmpeg.on('error', code => {
                    this.isRunning = false;
                    this._logEvent(`Error ${code}`);
                });

                this.isRunning = true;
            }
            catch (err) {
                this.isRunning = false;
                this._logEvent(`${err.message}`);
            }
        }
    }

    // Stop the input capture process
    Stop() {
        if (this._ffmpeg != undefined) {
            this.stdout = undefined;
            this._exitFlag = true;   // prevent automatic restarting of the process
            this._logEvent(`Stopping ffmpeg (rtp://${this.rtpIP}:${this.rtpPort})...`);
            this._ffmpeg.kill('SIGTERM');
    
            // ffmpeg stops on SIGTERM, but does not exit.
            // Send SIGKILL to quit process
            this._ffmpeg.kill('SIGKILL');
        }
    }
}

// Export class
module.exports.RtpInput = RtpInput;