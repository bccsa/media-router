// ======================================
// Audio Mixer input
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// External libraries
// -------------------------------------

//const stream = require('stream');
const volume = require('pcm-volume');
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
        this._volume = 1;                   // Mixer volume
        this._mute = false;
        this.showVolumeControl = true;      // Indicates that the front end should show the volume control
        this.showMuteControl = true;        // Indicates that the front end should show the mute control
        this._clientHtmlFileName = "AudioMixerInput.html";
        this.displayOrder = 0;              // Display order in the client WebApp.
        this.displayWidth = "80px";         // Display width in the client WebApp.
        this.stdin = new volume();          // Pass through transform stream used as ffmpeg input in the Audio Mixer

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

    // Toggle mute status
    ToggleMute() {
        this._mute = !this._mute;

        if (this._mute) {
            this.stdin.setVolume(0);
        }
        else {
            if (this._volume <= 0.1) {
                this.SetVolume(0.1);
            }
            this.stdin.setVolume(this._volume);
        }

        this._updateClientUI({
            mute : this._mute,
            volume : this._volume
        });
    }

    SetVolume(volume) {
        this._volume = volume;

        if (!this._mute) {
            this.stdin.setVolume(this._volume);
        }

        this._updateClientUI({
            volume : this._volume
        });
    }

    Start() {
        // Set running status
        this.isRunning = true;
    }

    Stop() {
        // Set running status
        this.isRunning = false;
    }

    // Get client UI status for given device name
    GetClientUIstatus() {
        return {
            mute : this._mute,
            volume : this._volume,
            showVolumeControl : this.showVolumeControl,
            showMuteControl : this.showMuteControl
        };
    }

    // Set client UI command for give device name
    SetClientUIcommand(clientData) {
        if (clientData != undefined) {
            if (clientData.mute != undefined && clientData.mute != this._mute)
            {
                this.ToggleMute();
            }

            if (clientData.volume != undefined)
            {
                this.SetVolume(clientData.volume);
            }
        }
    }
}

// Export class
module.exports.AudioMixerInput = AudioMixerInput;