const _paNullSinkBase = require('./_paNullSinkBase');
const { spawn } = require('child_process');
const path = require('path');

class SrtVideoPlayer extends _paNullSinkBase {
    constructor() {
        super();

        this._ffmpeg;
        this._gst;
        this.srtHost = 'srt';
        this.srtPort = 1234;
        this.srtMode = 'caller';
        this.srtLatency = 1;
        this.srtStreamID = '';
        this.display = '0'; 
        this.fullscreen = true;
        this.srtPbKeyLen = 16;
        this.srtPassphrase = '';
        this._udpSocketPort = 0;
        this.srtStats = '';         // SRT statistics in JSON string format
        this.SetAccess('srtStats', { Set: 'none' });
    }

    Init() {
        super.Init();

        // Get unique UDP socket port
        this._udpSocketPort = this._parent.GetUdpSocketPort();

        // Start external processes when the underlying pipe-source is ready (from extended class)
        this.on('ready', ready => {
            if (ready) {
                this._start_gst();
            }
        });

        // Stop external processes when the control is stopped (through setting this.run to false)
        this.on('run', run => {
            if (!run) {
                this._stop_gst();
            }
        });
    }

    _start_gst() {
        if (!this._gst) {
            try {
                let _this = this;
                // Request a PulseAudio connection
                this._parent.PaReqConnection();

                this._parent._log('INFO', `${this._controlName} (${this.displayName}): Starting srt video decoder (gstreamer)`);

                let crypto = '';
                if (this.srtPassphrase) { crypto = `&pbkeylen=${this.srtPbKeyLen}&passphrase=${this.srtPassphrase}` };

                let streamID = '';
                if (this.srtStreamID) { streamID = '&streamid=' + this.srtStreamID };

                let _uri = `srt://${this.srtHost}:${this.srtPort}?mode=${this.srtMode}&latency=${this.srtLatency}${streamID}${crypto}`;

                this._gst = spawn('node', [
                    `${path.dirname(process.argv[1])}/child_processes/SrtVideoPlayer_child.js`,
                    _uri,
                    this.sink,
                    this._parent.paLatency,
                    this.display,
                    this.fullscreen,
                    this.displayName
                ]);

                this._gst.stdout.on('data', (data) => {
                    _this._parent._log('INFO', `${this._controlName} (${this.displayName}): ${data}`);
                });
                
                this._gst.stderr.on('data', (data) => {
                    _this._parent._log('ERROR', `${this._controlName} (${this.displayName}): ${data}`);
                });
                
                this._gst.stdin.on('data', (data) => {
                    _this._parent._log('INFO', `${this._controlName} (${this.displayName}): ${data}`);
                });
                
                // Restart pipeline on exit
                this._gst.on('exit', (data) => {
                    this._parent._log('FATAL', `${this._controlName} (${this.displayName}): Got exit code, restarting in 1s`);
                    this._stop_gst();
                    setTimeout(() => { if (this.ready && this.run) { this._start_gst() } }, 1000);
                })

            }
            catch (err) {
                this._parent._log('FATAL', `${this._controlName} (${this.displayName}): opus decoder (gstreamer) error ${err.message}`);
                this._stop_gst();
            }
        }
    }

    _stop_gst() {
        if (this._gst) {
            this._gst.stdin.pause();
            this._gst.kill();
            this._gst = undefined;
        }
    }
}

module.exports = SrtVideoPlayer;