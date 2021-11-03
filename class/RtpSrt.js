// ======================================
// RTP UDP socket to SRT
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// External libraries
// -------------------------------------

const { spawn } = require('child_process');
const events = require('events');

// -------------------------------------
// Class declaration
// -------------------------------------

class RtpSrt {
    constructor() {
        this.rtpIP = '224.0.0.100';
        this.rtpPort = 3000;
        this.srtHost = 'srt.invalid';
        this.srtPort = 5000;
        this.srtMode = 'caller';
        this.srtPbKeyLen = 16;
        this.srtPassphrase = '';
        this.srtLatency = '200';

        this.log = new events.EventEmitter();
        this.srtLiveTransmit = undefined;
    }

    // public properties
    get Log() {
        return this.log;
    }

    // Start the process
    Start() {
        if (this.srtLiveTransmit == undefined) {
            try {
                let crypto = "";
                if (this.srtPassphrase != '') {
                    crypto = `&pbkeylen=${this.srtPbKeyLen}&passphrase=${this.srtPassphrase}`
                }
                let args = `udp://${this.rtpIP}:${this.rtpPort} srt://${this.srtHost}:${this.srtPort}?mode=${this.srtMode}&latency=${this.srtLatency}${crypto}`;
                this.srtLiveTransmit = spawn('srt-live-transmit', args.split(" "));

                // Handle stdout
                this.srtLiveTransmit.stdout.on('data', data => {
                    // parse stdout output here
                });

                // Handle stderr
                this.srtLiveTransmit.stderr.on('data', data => {
                    // parse stderr output here
                    console.log(data.toString());
                });

                // Handle process exit event
                this.srtLiveTransmit.on('close', code => {

                });

                // Handle process error events
                this.srtLiveTransmit.on('error', code => {

                });
            }
            catch (err) {
                this.log.emit('log', `srt-live-transmit ${this.srtHost}:${this.srtPort}: ${err.message}`);
            }
        }
    }

    // Stop the input capture process
    Stop() {
        if (this.srtLiveTransmit != undefined) {
            this.log.emit('log', `srt-live-transmit ${this.srtHost}:${this.srtPort} Stopping srt-live-transmit...`);
            this.srtLiveTransmit.kill('SIGTERM');
    
            // Send SIGKILL to quit process
            this.srtLiveTransmit.kill('SIGKILL');

            this.srtLiveTransmit = undefined;
        }
    }
}

// Export class
module.exports.RtpSrt = RtpSrt;