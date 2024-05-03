const _paNullSinkBase = require('./_paNullSinkBase');
const SrtBase = require('./SrtBase');
const path = require('path');
const { Classes } = require('../modular-dm');

class SrtOpusInput extends Classes(_paNullSinkBase, SrtBase) {
    constructor() {
        super();
        this._srtElementName = "srtserversrc";
    }

    Init() {
        super.Init();

        // Start external processes when the underlying pipe-source is ready (from extended class)
        this.on('ready', ready => {
            if (ready) {
                let _pipeline = `srtserversrc name=${this._srtElementName} uri="${this.uri()}" wait-for-connection=false ! ` +
                `tsdemux ignore-pcr=true latency=1 ! ` +
                `opusdec use-inband-fec=true plc=true ! ` + 
                `queue leaky=2 max-size-time=100000000 flush-on-eos=true ! ` + 
                `audioconvert ! audioresample ! ` +
                `pulsesink device="${this.sink}" sync=false buffer-time=${this._parent.paLatency * 1000} max-lateness=${this._parent.paLatency * 1000000}`

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

module.exports = SrtOpusInput;