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
        this.name = 'New RTP Input';    // Display name
        this.rtpIP = '224.0.0.100';     // RTP source IP address / host name (can be a multicast address)
        this.rtpPort = 3000;            // RTP UDP port
        this.rtpBitrate = 32;           // Opus bitrate in kbps
        this._ffmpeg = undefined;
    }

    // Start the input process
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
b=AS:${this.rtpBitrate}
a=rtpmap:97 opus/${this.sampleRate}/${this.channels}`);

                let args = `-hide_banner -fflags nobuffer -flags low_delay -protocol_whitelist file,udp,rtp -reorder_queue_size 0 -buffer_size 0 -i ${sdpFile} -c:a pcm_s${this.bitDepth}le -sample_rate ${this.sampleRate} -ac ${this.channels} -f s${this.bitDepth}le -`
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

                    // Restart after 1 second
                    setTimeout(() => {
                        if (!this._exitFlag) {
                            this._logEvent(`Restarting ffmpeg...`);
                            this.Start();
                        }
                    }, 1000);

                    this._ffmpeg = undefined;
                });

                // Handle process error events
                this._ffmpeg.on('error', code => {
                    this.isRunning = false;
                    this._logEvent(`Error "${code}"`);
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
        this._exitFlag = true;   // prevent automatic restarting of the process

        if (this._ffmpeg != undefined) {
            this.stdout = undefined;
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