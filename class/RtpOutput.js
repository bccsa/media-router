// ======================================
// PCM to RTP output via ffmpeg
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// External libraries
// -------------------------------------

const { spawn } = require('child_process');
const { _outputDevice } = require('./_outputDevice');

// -------------------------------------
// Class declaration
// -------------------------------------

class RtpOutput extends _outputDevice {
    constructor(DeviceList) {
        super(DeviceList);
        this.name = 'New RTP Output';   // Display name
        this.rtpIP = '224.0.0.100';     // RTP destination IP address / host name (can be a multicast address)
        this.rtpPort = 3000;            // RTP udp port
        this.rtpBitrate = 32;           // Opus bitrate in kbps
        this.sampleRate = 48000;        // Audio sample rate
        this.bitDepth = 16;             // Audio bit depth
        this.channels = 1;              // Audio channels
        this._ffmpeg = undefined;
    }

    // Start the output process
    Start() {
        this._exitFlag = false;   // Reset the exit flag
        if (this._ffmpeg == undefined) {
            try {
                let args = `-hide_banner -fflags nobuffer -flags low_delay -f s${bitDepth}le -sample_rate ${this.sampleRate} -ac ${this.channels} -i - -c:a libopus -sample_rate ${this.sampleRate} -ac ${this.channels} -b:a ${this.rtpBitrate}k -f rtp rtp://${this.rtpIP}:${this.rtpPort}`
                this._ffmpeg = spawn('ffmpeg', args.split(" "));
                this.stdin = this._ffmpeg.stdin;

                // Handle stderr
                this._ffmpeg.stderr.on('data', data => {
                    this._logEvent(`${data.toString()}`);
                });

                // Handle stdout
                this._ffmpeg.stdout.on('data', data => {
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
            this.stdin = undefined;
            this._logEvent(`Stopping ffmpeg (rtp://${this.rtpIP}:${this.rtpPort})...`);
            this._ffmpeg.kill('SIGTERM');
    
            // ffmpeg stops on SIGTERM, but does not exit.
            // Send SIGKILL to quit process
            this._ffmpeg.kill('SIGKILL');
        }
    }
}

// Export class
module.exports.RtpOutput = RtpOutput;