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

// -------------------------------------
// Class declaration
// -------------------------------------

class _inputDevice extends _device {
    constructor(DeviceList) {
        super(DeviceList);
        this.stdout = undefined;            // stdout mapped to process stdout
        this.channels = 1;                  // Audio channels
        this.sampleRate = 48000;            // Audio sample rate
        this.bitDepth = 16;                 // Audio bit depth
    }
}

// Export class
module.exports._inputDevice = _inputDevice;