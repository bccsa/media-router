// ======================================
// PCM to RTP output via ffmpeg
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// External libraries
// -------------------------------------

const { spawn } = require('child_process');
const { _audioOutputDevice } = require('./_audioOutputDevice');

// -------------------------------------
// Class declaration
// -------------------------------------

class RtpOpusOutput extends _audioOutputDevice {
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

        if (this.rtpPort % 2 != 0) {
            this._logEvent(`The RTP port (${this.rtpPort}) must be an even number.`);
        }
    }

    // Start the output process
    Start() {
        this._exitFlag = false;   // Reset the exit flag
        if (this._ffmpeg == undefined) {
            try {
                // Opus sample rate is always 48000. Input is therefore converted to 48000
                let args = `-hide_banner -probesize 32 -analyzeduration 0 -fflags nobuffer -flags low_delay -f s${this.bitDepth}le -sample_rate ${this.sampleRate} -ac ${this.channels} -i - -af aresample=async=1000 -f rtp -c:a libopus -sample_rate 48000 -ac ${this.channels} -b:a ${this.rtpBitrate}k rtp://${this.rtpIP}:${this.rtpPort}`
                this._ffmpeg = spawn('ffmpeg', args.split(" "));
                this.stdin.pipe(this._ffmpeg.stdin);

                // Handle stderr
                this._ffmpeg.stderr.on('data', data => {
                    // this._logEvent(`${data.toString()}`);
                });

                // Handle stdout
                this._ffmpeg.stdout.on('data', data => {
                    this._logEvent(`${data.toString()}`);
                });                

                // Handle process exit event
                this._ffmpeg.on('close', code => {
                    this.stdin.unpipe(this._ffmpeg.stdin);
                    this.isRunning = false;
                    if (code != null) { this._logEvent(`Closed (${code})`) }

                    this._ffmpeg.kill('SIGTERM');
                    this._ffmpeg.kill('SIGKILL');
                    this._ffmpeg = undefined;

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

            if (this._ffmpeg != undefined) {
                this.stdin.unpipe(this._ffmpeg.stdin);
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
module.exports.RtpOpusOutput = RtpOpusOutput;