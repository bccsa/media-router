const _paNullSinkBase = require('./_paNullSinkBase');
const SrtBase = require('./SrtBase');
const path = require('path');
const { Classes } = require('../modular-dm');

class SrtOpusOutput extends Classes(_paNullSinkBase, SrtBase) {
    constructor() {
        super();
        this.fec = false;           // Enable opus Forward Error Correction
        this.fecPacketLoss = 5;     // Opus FEC packet loss percentage (preset value)
        this.compression = 10;      // Opus compression level (0 - 10) where 0 is the lowest quality, and 10 is the highest quality.
        this.bitrate = 64;          // Opus encoding target bitrate in kbps
        this.outBitrate = 0;        // Opus encoder output bitrate
        this.SetAccess('outBitrate', { Set: 'none' });
        this._srtElementName = "srtserversink";
    }

    Init() {
        super.Init();

        // Start external processes when the underlying null-sink is ready (from extended class)
        this.on('ready', ready => {
            this._parent._log('INFO', `${this._controlName} (${this.displayName}): Starting opus encoder (gstreamer)`);
            
            if (ready) {
                let _pipeline = `pulsesrc device=${this.source} latency-time=${this._parent.paLatency * 1000} buffer-time=${this._parent.paLatency * 1000} ! ` + 
                `audio/x-raw,rate=${this.sampleRate},format=S${this.bitDepth}LE,channels=${this.channels} ! ` +
                `audioconvert ! audioresample ! ` +
                `queue max-size-time=100000000 leaky=2 flush-on-eos=true ! ` +
                `opusenc bitrate=${this.bitrate * 1000} audio-type=2051 bitrate-type=2 ! ` + 
                `mpegtsmux latency=1 alignment=7 ! ` + 
                `srtserversink name=${this._srtElementName} uri="${this.uri()}" sync=false wait-for-connection=false`

                this._parent.PaCmdQueue(() => { 
                    this._start_gst(`${path.dirname(process.argv[1])}/child_processes/SrtGstGeneric_child.js`, [
                        _pipeline,
                        this._srtElementName
                    ]);
                });
            }
        });

        // Stop external processes when the control is stopped (through setting this.run to false)
        this.on('run', run => {
            if (!run) {
                this._stop_gst();
            }
        });
    }

}

module.exports = SrtOpusOutput;