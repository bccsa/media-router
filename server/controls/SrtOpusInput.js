const _paNullSinkBase = require('./_paNullSinkBase');
const SrtBase = require('./SrtBase');
const path = require('path');
const { Classes } = require('../modular-dm');

class SrtOpusInput extends Classes(_paNullSinkBase, SrtBase) {
    constructor() {
        super();
    }

    Init() {
        super.Init();

        // Start external processes when the underlying pipe-source is ready (from extended class)
        this.on('ready', ready => {
            if (ready) {
                this._parent._log('INFO', `${this._controlName} (${this.displayName}): Starting opus decoder (gstreamer)`);

                this._parent.PaCmdQueue(() => { 
                    this._start_gst(`${path.dirname(process.argv[1])}/child_processes/SrtOpusInput_child.js`, [
                        this.uri(), 
                        this._parent.paLatency, 
                        this.sink
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