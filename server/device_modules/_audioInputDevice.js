// =====================================
// Base class for audio input devices
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// External libraries
// -------------------------------------

const _audioDevice = require('./_audioDevice');
const { PassThrough } = require('stream');

// -------------------------------------
// Class declaration
// -------------------------------------

/**
 * Base class for audio input modules
 * @extends _audioDevice
 * @property {array} destinations - Array of strings with destination device name(s)
 */
class _audioInputDevice extends _audioDevice {
    constructor() {
        super();
        this.stdout = new PassThrough();
        this.destinations = ["Destination device name"];

        // Find the destination device after 100ms
        setTimeout(() => {
            this.destinations.forEach(destinationName => {
                this._findDestination(destinationName);
            });
        }, 100);
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