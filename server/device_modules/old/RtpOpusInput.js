// ======================================
// RTP input via ffmpeg, encoded to PCM
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// External libraries
// -------------------------------------

const { spawn } = require('child_process');
const { _audioInputDevice } = require('./_audioInputDevice');
const fs = require('fs');

// -------------------------------------
// Class declaration
// -------------------------------------

class RtpOpusInput extends _audioInputDevice {
    constructor(DeviceList) {
        super(DeviceList);
        this.name = 'New RTP Input';    // Display name
        this.rtpIP = '224.0.0.100';     // RTP source IP address / host name (can be a multicast address)
        this.rtpPort = 3000;            // RTP UDP port
        this.rtpBitrate = 32;           // Opus bitrate in kbps
        this._ffmpeg = undefined;

        if (this.rtpPort % 2 != 0) {
            this._logEvent(`The RTP port (${this.rtpPort}) must be an even number.`);
        }
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
a=rtpmap:97 opus/48000/${this.channels}`);      // Opus sample rate should always be 48000

                let args = `-hide_banner -probesize 32 -analyzeduration 0 -fflags nobuffer -flags low_delay -protocol_whitelist file,udp,rtp -reorder_queue_size 0 -buffer_size 0 -c:a libopus -i ${sdpFile} -af aresample=async=1000 -c:a pcm_s${this.bitDepth}le -sample_rate ${this.sampleRate} -ac ${this.channels} -f s${this.bitDepth}le -`
                this._ffmpeg = spawn('ffmpeg', args.split(" "));
                this._ffmpeg.stdout.pipe(this.stdout);

                // Handle stderr
                this._ffmpeg.stderr.on('data', data => {
                    // this._logEvent(`${data.toString()}`);
                });
                
                // Handle process exit event
                this._ffmpeg.on('close', code => {
                    if (this._ffmpeg) {
                        this._ffmpeg.stdout.unpipe(this.stdout);
                        this._ffmpeg.kill('SIGTERM');
                        this._ffmpeg.kill('SIGKILL');
                        this._ffmpeg = undefined;
                    }

                    this.isRunning = false;
                    if (code != null) { this._logEvent(`Closed (${code})`) }

                    // Restart after 1 second
                    setTimeout(() => {
                        if (!this._exitFlag) {
                            this._logEvent(`Restarting ffmpeg...`);
                            this.Start();
                        }
                    }, 1000);
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
        try {
            this._exitFlag = true;   // prevent automatic restarting of the process

            if (this._ffmpeg) {
                this._ffmpeg.stdout.unpipe(this.stdout);
                this._logEvent(`Stopping ffmpeg (rtp://${this.rtpIP}:${this.rtpPort})...`);
                this._ffmpeg.kill('SIGTERM');
        
                // ffmpeg stops on SIGTERM, but does not exit.
                // Send SIGKILL to quit process
                this._ffmpeg.kill('SIGKILL');
            }
        }
        catch (error) {
            this._logEvent(error.message);
        }
    }
}

// Export class
module.exports.RtpOpusInput = RtpOpusInput;