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
    constructor(DeviceList) {
        super(DeviceList);
        this.name = 'New Audio Mixer';  // Display name
        this.channels = 1;              // Audio channels
        this.sampleRate = 48000;        // Audio sample rate
        this.bitDepth = 16;             // Audio bit depth
        this.clearInterval = 100;       // An interval in ms of when to dump the stream to keep the inputs in sync
        this._audioMixer = new AudioMixer.Mixer({
            channels: this.channels,
            bitDepth: this.bitDepth,
            sampleRate: this.sampleRate,
            clearInterval: this.clearInterval
        });
        this._inputList = [];           // List of mixer inputs
        this.stdout = this._audioMixer; // The underlying AudioMixer is a stream, and can be connected directly to stdout.
    }

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