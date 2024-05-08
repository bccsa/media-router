const _paNullSinkSourceBase = require('./_paNullSinkSourceBase');
const path = require('path');
const GstBase = require('./GstBase');
const { Classes } = require('../modular-dm');

class SoundProcessor extends Classes(_paNullSinkSourceBase, GstBase) {
    constructor() {
        super();
        this.eq = false;            // Enable opus Forward Error Correction
        this.band0 = 0;             // Band 0 gain
        this.band1 = 0;             // Band 1 gain
        this.band2 = 0;             // Band 2 gain
        this.band3 = 0;             // Band 3 gain
        this.band4 = 0;             // Band 4 gain
        this.band5 = 0;             // Band 5 gain
        this.band6 = 0;             // Band 6 gain
        this.band7 = 0;             // Band 7 gain
        this.band8 = 0;             // Band 8 gain
        this.band9 = 0;             // Band 9 gain
        
        //Delay Settings
        this.delay = false          // Enable Delay
        this.delayVal = 0;          // Delay Value

        // Gstreamer 
        this._gst;
    }

    Init() {
        super.Init();
        // Start external processes when the underlying null-sink is ready (from extended class)
        this.on('ready', ready => {
            if (ready) {
                // Source
                let _pipeline = `pulsesrc device=${this._source} ! ` +
                `audio/x-raw,rate=${this.sampleRate},format=S${this.bitDepth}LE,channels=${this.channels} ! `;
                // EQ
                _pipeline += `equalizer-10bands name="eq" ${this._bands()} ! `; 
                // Delay
                if (this.delay)
                _pipeline += `queue name="delay" leaky=2 min-threshold-time=${this.delayVal * 1000000} max-size-buffers=0 max-size-bytes=0 max-size-time=${(this.delayVal + 100) * 1000000} ! `
                
                // Sink 
                _pipeline += `pulsesink device=${this._sink}`;

                // ------------ start sound processor ------------ //
                this._parent.PaCmdQueue(() => { 
                    this._start_gst(`${path.dirname(process.argv[1])}/child_processes/SrtGstGeneric_child.js`, [
                        _pipeline
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

        // Add eventListeners for band's 
        for (let i = 0; i < 10; i++) {
            this.on(`band${i}`, val => {
                this.set_gst("eq", "gdouble", `band${i}`, val);
            })
        }

        // listen on EQ change
        this.on("eq", val => {
            this._setBands();
        })

        // Listen on DElay change (Live delay change does not work)
        // this.on("delayVal", val => {
        //     this.set_gst("delay", "int", `min-threshold-time`, val * 1000000);
        //     this.set_gst("delay", "int", `max-size-time`, (val + 100) * 1000000);
        // })
    }

    // create list of bands
    _bands(bandCount = 10) {
        let bands = "";
        for (let i = 0; i < bandCount; i++) {
            if (!this.eq) 
                bands += `band${i}=0 `;
            else 
                bands += `band${i}=${this[`band${i}`]} `;
        }
            
        return bands;
    }

    _setBands(bandCount = 10) {
        for (let i = 0; i < bandCount; i++) {
            if (!this.eq) 
                this.set_gst("eq", "gdouble", `band${i}`, 0);
            else 
                this.set_gst("eq", "gdouble", `band${i}`, this[`band${i}`]);
        }
    }

}

module.exports = SoundProcessor;