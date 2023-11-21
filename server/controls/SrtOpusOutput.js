const _paNullSinkBase = require('./_paNullSinkBase');
const { _SrtOpusOutput } = require('bindings')('../gst_modules/SrtOpusOutput/build/Release/gstreamer.node');

class SrtOpusOutput extends _paNullSinkBase {
    constructor() {
        super();
        this.fec = false;           // Enable opus Forward Error Correction
        this.fecPacketLoss = 5;     // Opus FEC packet loss percentage (preset value)
        this.compression = 10;      // Opus compression level (0 - 10) where 0 is the lowest quality, and 10 is the highest quality.
        this.bitrate = 64;          // Opus encoding target bitrate in kbps
        this._gst;
        this.srtHost = 'srt.invalid';
        this.srtPort = 1234;
        this.srtMode = 'caller';
        this.srtLatency = 1;
        this.srtStreamID = '';
        this.srtPbKeyLen = 16;
        this.srtPassphrase = '';
        this._udpSocketPort = 0;
        this.outBitrate = 0;        // Opus encoder output bitrate
        this.SetAccess('outBitrate', { Set: 'none' });
    }

    Init() {
        super.Init();

        // Get unique UDP socket port
        this._udpSocketPort = this._parent.GetUdpSocketPort();

        // Start external processes when the underlying null-sink is ready (from extended class)
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

                this._parent._log('INFO', `${this._controlName} (${this.displayName}): Starting opus encoder (gstreamer)`);

                let crypto = '';
                if (this.srtPassphrase) { crypto = `&pbkeylen=${this.srtPbKeyLen}&passphrase=${this.srtPassphrase}` };

                let streamID = '';
                if (this.srtStreamID) { streamID = '&streamid=' + this.srtStreamID };

                this._gst = new _SrtOpusOutput(
                    this.source,
                    this._parent.paLatency,
                    this.sampleRate,
                    this.bitDepth,
                    this.channels,
                    this.bitrate,
                    `srt://${this.srtHost}:${this.srtPort}?mode=${this.srtMode}&pkt_size=188&latency=${this.srtLatency}${streamID}${crypto}`
                );

                // Start 
                this._gst.Start((level, message) => {
                    this._parent._log(level, `${this._controlName} (${this.displayName}): ${message}`);
                });
            }
            catch (err) {
                this._parent._log('FATAL', `${this._controlName} (${this.displayName}): opus encoder (gstreamer) error ${err.message}`);
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

module.exports = SrtOpusOutput;