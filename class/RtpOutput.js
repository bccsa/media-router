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
        this.rtpIP = '224.0.0.100';
        this.rtpPort = 3000;
        this.inputSampleRate = 48000;
        this.inputFormat = 's16le';
        this.inputChannels = 1;
        this.outputChannels = 1;
        this.outputBitrate = 32; //kbps
        this.outputSampleRate = 48000;
        this.outputCodec = 'libopus';
        this._ffmpeg = undefined;
    }

    // Start the input capture process
    Start() {
        this._exitFlag = false;   // Reset the exit flag
        if (this._ffmpeg == undefined) {
            try {
                let args = `-hide_banner -fflags nobuffer -flags low_delay -f ${this.inputFormat} -sample_rate ${this.inputSampleRate} -ac ${this.inputChannels} -i - -c:a ${this.outputCodec} -sample_rate ${this.outputSampleRate} -ac ${this.outputChannels} -b:a ${this.outputBitrate}k -f rtp rtp://${this.rtpIP}:${this.rtpPort}`
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
            this.stdin = undefined;
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
module.exports.RtpOutput = RtpOutput;