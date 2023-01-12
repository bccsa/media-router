// ======================================
// Audio Mixer input
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// External libraries
// -------------------------------------

//const stream = require('stream');
const volume = require('../submodules/pcm-volume/index');
const { _audioTransformDevice } = require('./_audioTransformDevice');

// -------------------------------------
// Class declaration
// -------------------------------------

class AudioVolumeTransform extends _audioTransformDevice {
    constructor(DeviceList) {
        super(DeviceList);
        this.name = "New Mixer Input";      // String display name
        this.soloGroup = "";                // If not blank, mutes all AudioMixerInputs with the same soloGroup text.
        this.maxVolume = 1.5;               // Maximum volume that the client UI can request
        this.volume = 1;                    // Mixer volume
        this.mute = true;
        this.showVolumeControl = true;      // Indicates that the front end should show the volume control
        this.showMuteControl = true;        // Indicates that the front end should show the mute control
        this._clientHtmlFileName = "AudioMixerInput.html";
        this.displayOrder = 0;              // Display order in the client WebApp.
        this.displayWidth = "80px";         // Display width in the client WebApp.
        this.bitDepth = 16;
        this.stdin = new volume(this.volume, this.bitDepth);
        this.stdout = this.stdin;
        // this._peakPrev = 0;                 // Previous peak value
        
        setTimeout(() => {
            // Set volume transform stream settings after config has been set.
            this.stdin.setVolume(this.volume);
            this.stdin.setBitDepth(this.bitDepth);

            // Set initial mute
            this.SetMute(this.mute);
        }, 50);
    }

    // Toggle mute status
    ToggleMute() {
        this.mute = !this.mute;

        this.SetMute(this.mute);
    }

    SetMute(mute) {
        this.mute = mute;

        if (this.mute) {
            this.stdin.setVolume(0);
        }
        else {
            if (this.volume <= 0.1) {
                this.SetVolume(0.1);
            }
            this.stdin.setVolume(this.volume);
        }

        this._updateClientUI({
            mute : this.mute,
            volume : this.volume
        });

        // Mute all other AudioMixerInputs in solo group
        if (!this.mute && this.soloGroup != "") {
            this._deviceList.SoloGroup(this.soloGroup).forEach(m => {
                if (m.name != this.name && !m._mute) {
                    m.SetMute(true);
                }
            });
        }
    }

    SetVolume(volume) {
        this.volume = volume;

        if (!this.mute) {
            this.stdin.setVolume(this.volume);
        }

        this._updateClientUI({
            volume : this.volume
        });
    }

    Start() {
        // Set running status
        this.isRunning = true;

        // Send peak volume updates to client UI while running
        this._updatePeak();
    }

    Stop() {
        // Set running status
        this.isRunning = false;
    }

    // Get client UI status for given device name
    GetClientUIstatus() {
        return {
            mute : this.mute,
            volume : this.volume,
            showVolumeControl : this.showVolumeControl,
            showMuteControl : this.showMuteControl,
            maxVolume : this.maxVolume
        };
    }

    // Set client UI command for give device name
    SetClientUIcommand(clientData) {
        if (clientData) {
            if (clientData.mute && clientData.mute != this.mute)
            {
                this.ToggleMute();
            }

            if (clientData.volume)
            {
                this.SetVolume(clientData.volume);
            }
        }
    }

    // Send peak volume to client UI (used by volume indicator)
    _updatePeak() {
        if (this._isRunning) {
            setTimeout(() => {
                this._updateClientUI({
                    peak : this.stdin.peak
                });
                this._updatePeak();
            }, 200);
        }
        else {
            // Clear peak display on client UI
            this._updateClientUI({
                peak : 0
            });
        }
    }
}

// Export class
module.exports.AudioVolumeTransform = AudioVolumeTransform;