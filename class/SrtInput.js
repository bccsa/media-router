// ======================================
// SRT to RTP UDP socket
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// External libraries
// -------------------------------------

const { spawn } = require('child_process');
const { _device } = require('./_device');

// -------------------------------------
// Class declaration
// -------------------------------------

class SrtInput extends _device {
    constructor(DeviceList) {
        super(DeviceList);
        this.name = 'New SRT to RTP input';   // Display name
        this.rtpIP = '224.0.0.100';
        this.rtpPort = 3000;
        this.srtHost = 'srt.invalid';
        this.srtPort = 5000;
        this.srtMode = 'caller';
        this.srtPbKeyLen = 16;
        this.srtPassphrase = '';
        this.srtLatency = '200';
        this._srt = undefined;
    }

    // Start the process
    Start() {
        this._exitFlag = false;   // Reset the exit flag
        if (this._srt == undefined) {
            try {
                let crypto = "";
                if (this.srtPassphrase != '') {
                    crypto = `&pbkeylen=${this.srtPbKeyLen}&passphrase=${this.srtPassphrase}`
                }
                let args = `srt://${this.srtHost}:${this.srtPort}?mode=${this.srtMode}&latency=${this.srtLatency}${crypto} udp://${this.rtpIP}:${this.rtpPort}`;
                this._srt = spawn('srt-live-transmit', args.split(" "));

                // Handle stdout
                this._srt.stdout.on('data', data => {
                    this._logEvent(`${data.toString()}`);
                });

                // Handle stderr
                this._srt.stderr.on('data', data => {
                    this._logEvent(`${data.toString()}`);
                });

                // Handle process exit event
                this._srt.on('close', code => {
                    this.isRunning = false;
                    this._logEvent(`Closed (${code})`);

                    if (!this._exitFlag) {
                        // Restart after 1 second
                        setTimeout(() => {
                            this._logEvent(`Restarting srt-live-transmit...`);
                            this.Start();
                        }, 1000);
                    }

                    this._srt = undefined;
                });

                // Handle process error events
                this._srt.on('error', code => {
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
        if (this._srt != undefined) {
            this._exitFlag = true;   // prevent automatic restarting of the process
            this._logEvent(`Stopping srt-live-transmit...`);
            this._srt.kill('SIGTERM');
            
            // Send SIGKILL to quit process
            this._srt.kill('SIGKILL');
        }
    }
}

// Export class
module.exports.SrtInput = SrtInput;