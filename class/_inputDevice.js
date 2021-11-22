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
        this.channels = 1;                  // Audio channels
        this.sampleRate = 48000;            // Audio sample rate
        this.bitDepth = 16;                 // Audio bit depth
        this.volume = 100;                  // Mixer volume
        this._muteVolume = 100;             // Variable used to keep track of volume before mute
        this.showVolumeControl = true;      // Indicates that the front end should show the volume control
        this.showMuteControl = true;        // Indicates that the front end should show the mute control

        this._mixerInput = new AudioMixer.Input({
            channels: this.channels,
            bitDepth: this.bitDepth,
            sampleRate: this.sampleRate,
            volume: this.volume
        });

        // Find the mixer after 100ms
        setTimeout(() => {
            this._findMixer();
        }, 100)
    }

    // find the mixer
    _findMixer() {
        let m = this._deviceList.FindDevice(this.mixer);

        // Validate audio mixer
        if (m._audioMixer != undefined) { this._mixer = m; }

        if (this._mixer != undefined) {
            // Add mixer input to mixer
            this._mixer.AddInput(this);

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

    ToggleMute() {
        if (this._muteVolume < 10)
        {
            this._muteVolume = 10;
        }

        if (this.volume > 0)
        {
            this._muteVolume = this.volume;
            this.volume = 0;
            this._mixerInput.setVolume(0);
        }
        else {
            this.volume = this._muteVolume;
            this._mixerInput.setVolume(this._muteVolume);
        }
    }

    SetVolume(volume) {
        this.volume = volume;
        this._mixerInput.setVolume(volume);
    }
}

// Export class
module.exports._inputDevice = _inputDevice;