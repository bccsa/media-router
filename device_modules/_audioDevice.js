// =====================================
// Base class for audio devices
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// External libraries
// -------------------------------------

const _device = require('./_device');

// -------------------------------------
// Class declaration
// -------------------------------------

/**
 * Base class for audio input modules
 * @extends _device
 * @property {number} bitDepth - Audio bit depth (default = 16)
 * @property {number} channels - Audio channel number (default = 1)
 * @property {number} sampleRate - Audio sample rate (default = 48000)
 * @property {number} volume - Audio volume (1 = unity gain)
 * @property {number} maxVolume - Maximum volume that the client WebApp can request
 * @property {number} soloGroup - If not blank, mutes all AudioMixerInputs with the same soloGroup text.
 * @property {number} mute - If true, reduces the audio volume to zero.
 * @property {number} showVolumeControl - Indicates that the front end should show the volume control
 * @property {number} showMuteControl - Indicates that the front end should show the mute control
 * @property {number} displayOrder - Display order in the client WebApp.
 */
class _audioDevice extends _device {
    constructor() {
        super();
        this.channels = 1;
        this.sampleRate = 48000;
        this.bitDepth = 16;
        this.volume = 1;
        this.maxVolume = 1.5;
        this.soloGroup = "";
        this.mute = true;
        this.showVolumeControl = true;
        this.showMuteControl = true;
        this.displayOrder = 0;
        this.clientControl = "client_AudioInputDevice";

        // Mute all other modules (with the same parent) in the solo group
        this.on('mute', mute => {
            if (!mute && this.soloGroup) {
                Object.values(this._parent.controls).filter(c => c.soloGroup == this.soloGroup).forEach(device => {
                    if (device.name != this.name && !device.mute) device.mute = true;
                });
            }
        });
    }
}

// Export class
module.exports = _audioDevice;