// ======================================
// Audio Mixer devuce
// 
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// External libraries
// -------------------------------------

const AudioMixer = require('audio-mixer');
const events = require('events');

// -------------------------------------
// Class declaration
// -------------------------------------

class Mixer {
    constructor() {
        this.name = 'New Audio Mixer';   // Display name
        this._audioMixer = new AudioMixer({
            channels: 1,
            bitDepth: 16,
            sampleRate: 48000,
            clearInterval: 250
        });
        this.stdout = this._audioMixer;           // Name (string) of device who's stdout should be piped from
        this._log = new events.EventEmitter();
    }

    get log() { return this._log; }
    get channels() { return this._audioMixer.channels }
    set channels(val) { this._audioMixer.channels = val }
    get bitDepth() { return this._audioMixer.bitDepth }
    set bitDepth(val) { this._audioMixer.bitDepth = val }
    get sampleRate() { return this._audioMixer.sampleRate }
    set sampleRate(val) { this._audioMixer.sampleRate = val }
    get clearInterval() { return this._audioMixer.clearInterval }
    set clearInterval(val) { this._audioMixer.clearInterval = val }

    SetConfig(config) {
        Object.getOwnPropertyNames(config).forEach(k => {
            // Only update "public" properties
            if (this[k] != undefined && k[0] != '_' && (typeof k == 'number' || typeof k == 'string')) {
                this[k] = config[k];
            }
        });
    }

    GetConfig() {
        let c = {};
        Object.getOwnPropertyNames(this).forEach(k => {
            // Only return "public" properties
            if (k[0] != '_' && (typeof k == 'number' || typeof k == 'string')) {
                c[k] = this[k];
            }
        });
        return c;
    }

    Start() {
        // Do nothing. Mixer does not need to be started.
    }


    AddInput() {
        if (this._from == undefined || this._to == undefined) {
            // Search for the first occurance of the device name in the devices global object
            devices.MixerInput.forEach(i => {
                if (i.name == )
            });
            Object.keys(devices).forEach(k => {
                if (k != 'MixerInput') {
                    devices[k].forEach(d => {
                        if (this._from == undefined && d.name == this.source) {
                            this._from = d;
                        }
                        if (this._to == undefined && d.name == this.destination) {
                            this._to = d;
                        }
                        if (this._from != undefined && this._to != undefined) {
                            break;
                        }
                    })
                }
            });
        }

        // Check validity and start pipe
        if (this._from != undefined && this._to != undefined) {
            // Check for valid stdout and stdin
            if (this._from.stdout == undefined) {
                this._log.emit('log', `PipeConnector (${this.name}): Source stdout not available (${this.source})`);

                this._restart();
            }
            if (this._to.stdin == undefined) {
                this._log.emit('log', `PipeConnector (${this.name}): Destination stdin not available (${this.destination})`);

                this._restart();
            }

            // Start pipe
            if (this._from.stdout != undefined & this._to.stdin != undefined) {
                try {
                    this._from.stdout.pipe(this._to.stdin);
                }
                catch (err) {
                    this._log.emit('log', `PipeConnector (${this.name}): Unable to start pipe ${this.source} -> ${this.destination} (${err.message})`);

                    this._restart();
                }
            }
        }
        else {
            this._log.emit('log', `PipeConnector (${this.name}): Unable to start pipe ${this.source} -> ${this.destination} (Source or Destination not found)`);
        }
    }
}

// Export class
module.exports.Mixer = Mixer;