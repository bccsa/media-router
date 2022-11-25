// =====================================
// Base class for input devices. Includes
// an AudioMixer.Input
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// External libraries
// -------------------------------------

const _device = require('./_device');
const { PassThrough } = require('stream');

// -------------------------------------
// Class declaration
// -------------------------------------

/**
 * Base class for audio input modules
 * @extends _device
 * @property {number} bitDepth - Audio bit depth (default = 14)
 * @property {number} channels - Audio channel number (default = 1)
 * @property {number} sampleRate - Audio sample rate (default = 48000)
 * @property {array} destinations - Array of strings with destination device name(s)
 * @property {number} volume - Audio volume (1 = unity gain)
 * @property {number} maxVolume - Maximum volume that the client WebApp can request
 * @property {number} soloGroup - If not blank, mutes all AudioMixerInputs with the same soloGroup text.
 * @property {number} mute - If true, reduces the audio volume to zero.
 * @property {number} showVolumeControl - Indicates that the front end should show the volume control
 * @property {number} showMuteControl - Indicates that the front end should show the mute control
 * @property {number} displayOrder - Display order in the client WebApp.
 */
class _audioInputDevice extends _device {
    constructor() {
        super();
        this.stdout = new PassThrough();
        this.channels = 1;
        this.sampleRate = 48000;
        this.bitDepth = 16;
        this._volume = 1;
        this.maxVolume = 1.5;
        this.soloGroup = "";
        this._mute = true;
        this.showVolumeControl = true;
        this.showMuteControl = true;
        this._clientHtmlFileName = "AudioMixerInput.html";
        this.displayOrder = 0;
        // this.displayWidth = "80px";         // Display width in the client WebApp.

        this.destinations = ["Destination device name"];
        // this._destinations = {};

        // Find the destination device after 100ms
        setTimeout(() => {
            this.destinations.forEach(destinationName => {
                this._findDestination(destinationName);
            });
        }, 100);
    }

    /**
     * Set the audio volume (1 = unity gain)
     */
    set volume(volume) {
        let prev = this._volume;
        this._volume = volume;
        if (volume != prev) this.emit('volume', this._volume);
    }

    /**
     * Get the audio volume (1 = unity gain)
     */
    get volume() {
        return this._volume;
    }

    /**
     * Set the audio mute to on or off
     */
    set mute(mute) {
        let prev = this._mute;
        this._mute = mute;
        if (mute != prev) this.emit('mute', this._mute);

        // Mute all other objects (with the same parent) in the solo group
        if (!mute && this.soloGroup) {
            Object.values(this._parent.controls).filter(c => c.soloGroup == this.soloGroup).forEach(device => {
                if (device.name != this.name && !device.mute) device.mute = true;
            });
        }
    }

    /**
     * Get the audio mute value
     */
    get mute() {
        return this._mute;
    }

    // find the destination device
    _findDestination(destinationName) {
        let dest = this._parent.controls[destinationName];

        // Check for valid output device
        if (dest && dest.AddInput) {
            // this._destinations[destinationName] = dest;

            // Link input device to destination output device
            dest.AddInput(this);
        }
        else {
            this._logEvent(`Unable to find destination device "${destinationName}", or destination device not of _audioOutputDevice type`);
        }
    }
}

// Export class
module.exports = _audioInputDevice;