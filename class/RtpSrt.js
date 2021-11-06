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
        this.name = 'New RTP to SRT output';   // Display name
        this.rtpIP = '224.0.0.100';
        this.rtpPort = 3000;
        this.srtHost = 'srt.invalid';
        this.srtPort = 5000;
        this.srtMode = 'caller';
        this.srtPbKeyLen = 16;
        this.srtPassphrase = '';
        this.srtLatency = '200';

        this._log = new events.EventEmitter();
        this._srt = undefined;
    }

    get type() {
        return this.constructor.name;
    }

    get log() {
        return this._log;
    }

    SetConfig(config) {
        Object.keys(config).forEach(k => {
            // Only update "public" properties excluding stdin and stdout properties
            if (this[k] != undefined && k[0] != '_' && k != 'type' && (typeof k == Number || typeof k == String)) {
                this[k] = config[k];
            }
        });
    }

    GetConfig() {
        let c = {};
        Object.keys(this).forEach(k => {
            // Only return "public" properties
            if (k[0] != '_' && (typeof k == Number || typeof k == String)) {
                c[k] = this[k];
            }
        });
        return c;
    }

    // Start the process
    Start() {
        if (this._srt == undefined) {
            try {
                let crypto = "";
                if (this.srtPassphrase != '') {
                    crypto = `&pbkeylen=${this.srtPbKeyLen}&passphrase=${this.srtPassphrase}`
                }
                let args = `udp://${this.rtpIP}:${this.rtpPort} srt://${this.srtHost}:${this.srtPort}?mode=${this.srtMode}&latency=${this.srtLatency}${crypto}`;
                this._srt = spawn('srt-live-transmit', args.split(" "));

                // Handle stdout
                this._srt.stdout.on('data', data => {
                    this._log.emit('log', `srt-live-transmit ${this.srtHost}:${this.srtPort}: ${data}`);
                });

                // Handle stderr
                this._srt.stderr.on('data', data => {
                    this._log.emit('log', `srt-live-transmit ${this.srtHost}:${this.srtPort}: ${data}`);
                });

                // Handle process exit event
                this._srt.on('close', code => {
                    this._log.emit('log', `srt-live-transmit ${this.srtHost}:${this.srtPort}: Closed (${code})`);
                });

                // Handle process error events
                this._srt.on('error', code => {
                    this._log.emit('log', `srt-live-transmit ${this.srtHost}:${this.srtPort}: Error ${code}`);
                });
            }
            catch (err) {
                this._log.emit('log', `srt-live-transmit ${this.srtHost}:${this.srtPort}: ${err.message}`);
            }
        }
    }

    // Stop the input capture process
    Stop() {
        if (this._srt != undefined) {
            this._log.emit('log', `srt-live-transmit ${this.srtHost}:${this.srtPort}: Stopping srt-live-transmit...`);
            this._srt.kill('SIGTERM');
    
            // Send SIGKILL to quit process
            this._srt.kill('SIGKILL');

            this._srt = undefined;
        }
    }
}

// Export class
module.exports.RtpSrt = RtpSrt;