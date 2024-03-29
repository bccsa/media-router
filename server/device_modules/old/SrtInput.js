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
        this.srtMaxBw = 8000;                  // SRT maxbw (maximum bandwidth) in byte per seconds
        this._srt = undefined;

        // Subscribe to DeviceList start and stop events
        DeviceList.run.on('start', () => {
            this.Start();
        });

        DeviceList.run.on('stop', () => {
            this.Stop();
        });
    }

    // Start the process
    Start() {
        if (this.rtpPort % 2 != 0) {
            this._logEvent(`The RTP port (${this.rtpPort}) must be an even number.`);
            return;
        }

        if (this.srtPassphrase.length > 0 && (this.srtPassphrase.length < 10 || this.srtPassphrase.length > 79)) {
            this._logEvent(`The SRT passphrase should be between 10 and 79 characters`);
            return;
        }

        this._exitFlag = false;   // Reset the exit flag
        if (this._srt == undefined) {
            try {
                let crypto = "";
                if (this.srtPassphrase != '') {
                    crypto = `&pbkeylen=${this.srtPbKeyLen}&passphrase=${this.srtPassphrase}`
                }
                let args = `srt://${this.srtHost}:${this.srtPort}?mode=${this.srtMode}&latency=${this.srtLatency}&maxbw=${this.srtMaxBw}${crypto} udp://${this.rtpIP}:${this.rtpPort}`;
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
                    if (this._srt) {
                        this._srt.kill('SIGTERM');
                        this._srt.kill('SIGKILL');
                        this._srt = undefined;
                    }
                    this.isRunning = false;
                    if (code != null) { this._logEvent(`Closed (${code})`) }

                    // Restart after 1 second
                    setTimeout(() => {
                        if (!this._exitFlag) {
                            this._logEvent(`Restarting srt-live-transmit...`);
                            this.Start();
                        }
                    }, 1000);
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

    // Stop the input capture process
    Stop() {
        try {
            this._exitFlag = true;   // prevent automatic restarting of the process

            if (this._srt) {
                this._logEvent(`Stopping srt-live-transmit...`);
                this._srt.kill('SIGTERM');
                
                // Send SIGKILL to quit process
                this._srt.kill('SIGKILL');
            }
        }
        catch (error) {
            this._logEvent(error.message);
        }
        
    }
}

// Export class
module.exports.SrtInput = SrtInput;