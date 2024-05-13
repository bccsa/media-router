const _paNullSinkSourceBase = require('./_paNullSinkSourceBase');
const path = require('path');
const GstBase = require('./GstBase');
const { Classes } = require('../modular-dm');

class SoundProcessor extends Classes(_paNullSinkSourceBase, GstBase) {
    constructor() {
        super();
        // EQ settings
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

        // Gate / Expander 
        this.gate = false;
        this.gate_knee = 2.8;
        this.gate_ratio = 1;
        this.gate_threshold = 0.001;
        this.gate_attack = 20;
        this.gate_release = 250;
        this.gate_makeup = 1;

        // Audio Compressor
        this.compressor = false;
        this.comp_knee = 2.8;
        this.comp_ratio = 1;
        this.comp_threshold = 0.001;
        this.comp_makeup = 1;
        this.comp_mix = 1;
        this.comp_attack = 20;
        this.comp_release = 250;

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
                `audio/x-raw,rate=${this.sampleRate},format=S${this.bitDepth}LE,channels=${this.channels} ! audioconvert ! audiorate ! `;
                // EQ
                _pipeline += `equalizer-10bands name="eq" ${this._bands()} ! `; 
                // Gate
                _pipeline += `calf-sourceforge-net-plugins-Gate name="gate" bypass=${!this.gate} knee=${this.gate_knee} ratio=${this.gate_ratio} threshold=${this.gate_threshold} attack=${this.gate_attack} release=${this.gate_release} makeup=${this.gate_makeup} ! `;
                // Compressor
                _pipeline += `calf-sourceforge-net-plugins-Compressor name="compressor" bypass=${!this.compressor} knee=${this.comp_knee} ratio=${this.comp_ratio} threshold=${this.comp_threshold} makeup=${this.comp_makeup} mix=${this.comp_mix} attack=${this.comp_attack} release=${this.comp_release} ! `;
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

        // ------------ EQ ------------ //

        // Add eventListeners for band's 
        for (let i = 0; i < 10; i++) {
            this.on(`band${i}`, val => {
                if (this.eq)
                    this.set_gst("eq", "gdouble", `band${i}`, val);
            })
        }

        // listen on EQ change
        this.on("eq", val => {
            this._setBands();
        })

        // ------------ EQ ------------ //

        // ------------ Audio Gate ------------ //

        this.on("gate", val => {
            this.set_gst("gate", "bool", `bypass`, !val);
        })

        this.on("gate_knee", val => {
            this.set_gst("gate", "gdouble", `knee`, val);
        })

        this.on("gate_ratio", val => {
            this.set_gst("gate", "gdouble", `ratio`, val);
        })

        this.on("gate_threshold", val => {
            this.set_gst("gate", "gdouble", `threshold`, val);
        })

        this.on("gate_attack", val => {
            this.set_gst("gate", "gdouble", `attack`, val);
        })

        this.on("gate_release", val => {
            this.set_gst("gate", "gdouble", `release`, val);
        })

        this.on("gate_makeup", val => {
            this.set_gst("gate", "gdouble", `makeup`, val);
        })

        // ------------ Audio Gate ------------ //

        // ------------ Audio Compressor ------------ //

        this.on("compressor", val => {
            this.set_gst("compressor", "bool", `bypass`, !val);
        })

        this.on("comp_knee", val => {
            this.set_gst("compressor", "gdouble", `knee`, val);
        })

        this.on("comp_ratio", val => {
            this.set_gst("compressor", "gdouble", `ratio`, val);
        })

        this.on("comp_threshold", val => {
            this.set_gst("compressor", "gdouble", `threshold`, val);
        })

        this.on("comp_makeup", val => {
            this.set_gst("compressor", "gdouble", `makeup`, val);
        })

        this.on("comp_mix", val => {
            this.set_gst("compressor", "gdouble", `mix`, val);
        })

        this.on("comp_attack", val => {
            this.set_gst("compressor", "gdouble", `attack`, val);
        })

        this.on("comp_release", val => {
            this.set_gst("compressor", "gdouble", `release`, val);
        })

        // ------------ Audio Compressor ------------ //

        // ------------ Delay ------------ //

        // Listen on DElay change (Live delay change does not work)
        // this.on("delayVal", val => {
        //     this.set_gst("delay", "int", `min-threshold-time`, val * 1000000);
        //     this.set_gst("delay", "int", `max-size-time`, (val + 100) * 1000000);
        // })

        // ------------ Delay ------------ //
    }

    /**
     * Create a list of bands with their set gain
     * @param {Number} bandCount - Number of bands (Dafualt: 10)
     * @returns String of bands
     */
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

    /**
     * Set gain on all bands
     * @param {Number} bandCount - Number of bands (Dafualt: 10)
     */
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