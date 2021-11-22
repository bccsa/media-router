// ======================================
// RTP UDP socket to SRT
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

class SrtOutput extends _device {
    constructor(DeviceList) {
        super(DeviceList);
        this.name = 'New RTP to SRT output';   // Display name
        this.rtpIP = '224.0.0.100';
        this.rtpPort = 3000;
        this.srtHost = 'srt.invalid';
        this.srtPort = 5000;
        this.srtMode = 'caller';
        this.srtPbKeyLen = 16;
        this.srtPassphrase = '';
        this.srtLatency = '200';
        this.srtMaxBw = 8;                  // SRT maxbw (maximum bandwidth) in kilobyte per second
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
                let args = `udp://${this.rtpIP}:${this.rtpPort} srt://${this.srtHost}:${this.srtPort}?mode=${this.srtMode}&latency=${this.srtLatency}${crypto}&maxbw=${this.srtMaxBw}`;
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

                    // Restart after 1 second
                    setTimeout(() => {
                        if (!this._exitFlag) {
                            this._logEvent(`Restarting srt-live-transmit...`);
                            this.Start();
                        }
                    }, 1000);

                    this._srt = undefined;
                });

                // Handle process error events
                this._srt.on('error', code => {
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

    // Stop the process
    Stop() {
        this._exitFlag = true;   // prevent automatic restarting of the process

        if (this._srt != undefined) {
            this._logEvent(`Stopping srt-live-transmit...`);
            this._srt.kill('SIGTERM');
            
            // Send SIGKILL to quit process
            this._srt.kill('SIGKILL');
        }
    }
}

// Export class
module.exports.SrtOutput = SrtOutput;