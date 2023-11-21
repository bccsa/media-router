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

                // // let args = `srtsrc uri="srt://${this.srtHost}:${this.srtPort}?mode=${this.srtMode}${latency}${streamID}${crypto}&payloadsize=188" ! application/x-rtp,media=audio,clock-rate=48000,encoding-name=OPUS,payload=96 ! rtpopusdepay ! opusdec ! audioconvert ! audioresample ! pulsesink device="${this.sink}"`;
                // let args = `srtsrc wait-for-connection=false uri="srt://${this.srtHost}:${this.srtPort}?mode=${this.srtMode}&latency=${this.srtLatency}${streamID}${crypto}" ! tsdemux latency=1 ignore-pcr=true ! opusdec ! audioconvert ! audioresample ! queue leaky="upstream" max-size-bytes=0 ! pulsesink device="${this.sink}" buffer-time=10000`;
                // // let args = `srtsrc wait-for-connection=false uri="srt://${this.srtHost}:${this.srtPort}?mode=${this.srtMode}&latency=${this.srtLatency}${streamID}${crypto}" ! application/x-rtp,media=audio,clock-rate=48000,encoding-name=OPUS,payload=96 ! rtpopusdepay ! opusdec ! audioconvert ! audioresample ! queue leaky="upstream" ! pulsesink device="${this.sink}" latency-time=${this._parent.paLatency * 1000}`;

                // this._gst = spawn('gst-launch-1.0', args.replace(/\s+/g, ' ').split(" "));

                // // Handle stderr
                // this._gst.stderr.on('data', data => {
                //     this._parent._log('ERROR', data.toString());
                // });

                // // Handle stdout
                // this._gst.stdout.on('data', data => {
                //     this._parent._log('INFO', data.toString());
                // });

                // // Handle process exit event
                // this._gst.on('close', code => {
                //     if (code != null) { this._parent._log('INFO', `${this._controlName} (${this.displayName}): opus decoder (gstreamer) stopped (${code})`) }
                //     this._stop_gst();

                //     // Auto restart if run command is still active
                //     setTimeout(() => {
                //         if (this.run & !this._gst) {
                //             this._start_gst();
                //         }
                //     }, 5000);
                // });

                // // Handle process error events
                // this._gst.on('error', code => {
                //     this._parent._log('ERROR', `${this._controlName} (${this.displayName}): opus decoder (gstreamer) error #${code}`);
                //     this._stop_gst();
                // });
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