// ======================================
// Audio Mixer input
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// External libraries
// -------------------------------------

const stream = require('stream');
const { _outputDevice } = require('./_outputDevice');

// -------------------------------------
// Class declaration
// -------------------------------------

class AudioMixerInput extends _outputDevice {
    constructor(DeviceList) {
        super(DeviceList);
        this.name = "New Mixer Input";      // String display name
        this.mixer = "New Audio Mixer";     // String name of the mixer to which the input belongs
        this._mixer = undefined;            // Mixer to which the input belongs
        this.channels = 1;                  // Audio channels
        this.sampleRate = 48000;            // Audio sample rate
        this.bitDepth = 16;                 // Audio bit depth
        this.volume = 100;                  // Mixer volume
        this._muteVolume = 100;             // Variable used to keep track of volume before mute
        this.showVolumeControl = true;      // Indicates that the front end should show the volume control
        this.showMuteControl = true;        // Indicates that the front end should show the mute control
        this._clientHtmlFileName = "MixerInput.html";
        this.displayOrder = 0;              // Display order in the client WebApp.
        this.displayWidth = "80px";              // Display width in the client WebApp.
        this.stdin = new stream.PassThrough();   // Pass through stream used as ffmpeg input in the Audio Mixer

        // Find the mixer after 100ms
        setTimeout(() => {
            this._findMixer();
        }, 100)
    }

    // find the mixer
    _findMixer() {
        let m = this._deviceList.FindDevice(this.mixer);

        // Validate audio mixer
        if (m != undefined && m.AddInput != undefined) { this._mixer = m; }

        if (this._mixer != undefined) {
            // Add mixer input to mixer
            this._mixer.AddInput(this);
        }
        else {
            this._logEvent(`Unable to find mixer "${this.mixer}"`);
        }
    }

    ToggleMute() {
        // if (this._muteVolume < 10)
        // {
        //     this._muteVolume = 10;
        // }

        // if (this.volume > 0)
        // {
        //     this._muteVolume = this.volume;
        //     this.volume = 0;
        //     this._mixerInput.setVolume(0);
        // }
        // else {
        //     this.volume = this._muteVolume;
        //     this._mixerInput.setVolume(this._muteVolume);
        // }
    }

    SetVolume(volume) {
        // this.volume = volume;
        // this._mixerInput.setVolume(volume);
    }

    Start() {
        // Set running status
        this.isRunning = true;
    }

    Stop() {
        // Set running status
        this.isRunning = false;
    }
}

// Export class
module.exports.AudioMixerInput = AudioMixerInput;