// =====================================
// Base class for input devices. Includes
// an AudioMixer.Input
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// External libraries
// -------------------------------------

const { _device } = require('./_device');
const { PassThrough } = require ('stream');

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
 */
class _audioInputDevice extends _device {
    constructor(DeviceList) {
        super(DeviceList);
        this.stdout = new PassThrough();    // stdout mapped to process stdout
        this.channels = 1;                  // Audio channels
        this.sampleRate = 48000;            // Audio sample rate
        this.bitDepth = 16;                 // Audio bit depth
        this.volume = 1;                    // Volume

        this.destinations = [ "Destination device name" ];
        this._destinations = {};

        // Find the destination device after 100ms
        setTimeout(() => {
            this.destinations.forEach(destinationName => {
                this._findDestination(destinationName);
            });
        }, 100);
    }

    // find the destination device
    _findDestination(destinationName) {
        this._destinations[destinationName] = this._deviceList.FindDevice(destinationName);

        // Check for valid output device
        if (this._destinations[destinationName] && this._destinations[destinationName].AddInput) {
            // Link input device to destination output device
            this._destinations[destinationName].AddInput(this);
        }
        else {
            this._logEvent(`Unable to find destination device "${destinationName}", or destination device not of _audioOutputDevice type`);
            
            // Retry to find the destination device in 1 second
            //setTimeout(() => { this._findDestination(destinationName) }, 1000);
        }
    }
}

// Export class
module.exports._audioInputDevice = _audioInputDevice;