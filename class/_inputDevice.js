// ======================================
// Base class for input devices. Includes
// an AudioMixer.Input
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// External libraries
// -------------------------------------

const { _device } = require('./_device');
const AudioMixer = require('audio-mixer');

// -------------------------------------
// Class declaration
// -------------------------------------

class _inputDevice extends _device {
    constructor(DeviceList) {
        super(DeviceList);
        this.stdout = undefined;            // stdout mapped to process stdout
        this.mixer = "New Audio Mixer";     // String name of the mixer to which the input belongs
        this._mixer = undefined;            // Mixer to which the input belongs
        this._mixerInput = new AudioMixer.Input({
            channels: 1,
            bitDepth: 16,
            sampleRate: 48000,
            volume: 100
        });
        this._muteVolume = 100;             // Variable used to keep track of volume before mute
        this.showVolumeControl = true;      // Indicates that the front end should show the volume control
        this.showMuteControl = true;        // Indicates that the front end should show the mute control

        // Find the mixer after 100ms
        setTimeout(() => {
            this._findMixer();
        }, 100)
    }

    get channels() { return this._mixerInput.channels; }
    set channels(val) { this._mixerInput.channels = val; }
    get bitDepth() { return this._mixerInput.bitDepth; }
    set bitDepth(val) { this._mixerInput.bitDepth = val; }
    get sampleRate() { return this._mixerInput.sampleRate; }
    set sampleRate(val) { this._mixerInput.sampleRate = val; }
    get volume() { return this._mixerInput.volume; }            // volume percentage 
    set volume(volume) { this._mixerInput.volume = volume; }    // volume percentage

    // find the mixer
    _findMixer() {
        let m = this._deviceList.FindDevice(this.mixer);
        if (typeof m == "Mixer") { this._mixerInput = m; }

        if (this._mixer != undefined) {
            // Add mixer input to mixer
            this._mixer.AddInput(this._mixerInput);

            // event subscriptions
            this._mixer.run.on('start', () => {
                // Start process when the mixer signals a start
                this.Start();
            });

            this._mixer.run.on('stop', () => {
                // Stop process when the mixer signals stop
                this.Stop();
            });
        }
        else {
            this._logEvent(`Unable to find mixer "${this.mixer}"`);
            
            // Retry to find the mixer in 1 second
            setTimeout(() => { this._findMixer() }, 1000);
        }
    }

    // Toggle mute
    ToggleMute() {
        if (this._muteVolume < 10)
        {
            this._muteVolume = 10;
        }

        if (this.volume > 0)
        {
            this._muteVolume = this.volume;
            this.volume = 0;
        }
        else {
            this.volume = this._muteVolume;
        }
    }
}

// Export class
module.exports._inputDevice = _inputDevice;