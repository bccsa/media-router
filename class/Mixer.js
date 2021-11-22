// ======================================
// Audio Mixer device
// 
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// External libraries
// -------------------------------------

const AudioMixer = require('audio-mixer');
const { _device } = require('./_device');

// -------------------------------------
// Class declaration
// -------------------------------------

class Mixer extends _device {
    constructor() {
        super(DeviceList);
        this.name = 'New Audio Mixer';  // Display name
        this._audioMixer = new AudioMixer({
            channels: 1,
            bitDepth: 16,
            sampleRate: 48000,
            clearInterval: 250
        });
        this._inputList = [];           // List of mixer inputs
        this.stdout = this._audioMixer; // The underlying AudioMixer is a stream, and can be connected directly to stdout.
    }

    get channels() { return this._audioMixer.channels; }
    set channels(val) { this._audioMixer.channels = val; }
    get bitDepth() { return this._audioMixer.bitDepth; }
    set bitDepth(val) { this._audioMixer.bitDepth = val; }
    get sampleRate() { return this._audioMixer.sampleRate; }
    set sampleRate(val) { this._audioMixer.sampleRate = val; }
    get clearInterval() { return this._audioMixer.clearInterval; }
    set clearInterval(val) { this._audioMixer.clearInterval = val; }

    get inputList() { return _this.inputList; }

    // Add input to AudioMixer
    AddInput(input) {
        if (input._mixer != undefined) {
            this._audioMixer.addInput(input._mixerInput);
            this._inputList.push(input);
        }
        else {
            if (input.name != undefined) {
                this._logEvent(`Unable to add mixer input "${input.name}": invalid type`);
            }
            else {
                this._logEvent(`Unable to add mixer input: invalid type`);
            }
        }
    }

    Start() {
        // Signal start to subscribing devices
        this.isRunning = true;
    }

    Stop() {
        // Signal stop to subscribing devices
        this.isRunning = false;
    }
}

// Export class
module.exports.Mixer = Mixer;