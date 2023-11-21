const _paNullSinkBase = require('./_paNullSinkBase');
const { _SrtOpusInput } = require('bindings')('../gst_modules/SrtOpusInput/build/Release/gstreamer.node');

class SrtOpusInput extends _paNullSinkBase {
    constructor() {
        super();

        this._ffmpeg;
        this._gst;
        this._srt;
        this.srtHost = 'srt.invalid';
        this.srtPort = 1234;
        this.srtMode = 'caller';
        this.srtLatency = 1;
        this.srtStreamID = '';
        this.srtPbKeyLen = 16;
        this.srtPassphrase = '';
        this._udpSocketPort = 0;
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
                // Request a PulseAudio connection
                this._parent.PaReqConnection();

                this._parent._log('INFO', `${this._controlName} (${this.displayName}): Starting opus decoder (gstreamer)`);

                let crypto = '';
                if (this.srtPassphrase) { crypto = `&pbkeylen=${this.srtPbKeyLen}&passphrase=${this.srtPassphrase}` }

                let streamID = '';
                if (this.srtStreamID) { streamID = '&streamid=' + this.srtStreamID }

                this._gst = new _SrtOpusInput(
                    `srt://${this.srtHost}:${this.srtPort}?mode=${this.srtMode}&payloadsize=188&latency=${this.srtLatency}${streamID}${crypto}`,
                    this._parent.paLatency,
                    this.sink
                );

                // Start 
                this._gst.Start((level, message) => {
                    this._parent._log(level, `${this._controlName} (${this.displayName}): ${message}`);
                });
            }
            catch (err) {
                this._parent._log('FATAL', `${this._controlName} (${this.displayName}): opus decoder (gstreamer) error ${err.message}`);
                this._stop_gst();
            }
        }
    }

    _stop_gst() {
        if (this._gst) {
            this._gst.Stop();
            this._gst = undefined;
        }
    }
}

module.exports = SrtOpusInput;