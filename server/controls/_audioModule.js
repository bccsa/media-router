let { dm } = require('../modular-dm');

/**
 * Base class for PulseAudio modules
 */
class _audioModule extends dm {
    constructor() {
        super();
        this.maxVolume = 1.5;
        this.soloGroup = "";
        this.mute = true;
        this.showVolumeControl = true;
        this.showMuteControl = true;
        this.displayOrder = 0; // display order on client interface
        this.clientControl = "client_AudioInputDevice";
        /**
         * PulseAudio source name
         * @type {string}
         */
        this.paSource = "";
        /**
         * PulseAudio sink name
         * @type {string}
         */
        this.paSink = "";
    }

    Init() {
        // Mute all other modules (with the same parent) in the solo group
        this.on('mute', mute => {
            if (!mute && this.soloGroup) {
                Object.values(this._parent.controls).filter(c => c.soloGroup == this.soloGroup).forEach(m => {
                    if (m.name != this.name && !m.mute) m.mute = true;
                });
            }
        });
    }

    // To do:
    // Add VU meter recording through parec with low sample rate
}

module.exports = _audioModule;