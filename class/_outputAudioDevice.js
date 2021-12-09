// ======================================
// Base class for output devices
// 
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

class _outputAudioDevice extends _device {
    constructor(DeviceList) {
        super(DeviceList);
        this.stdin = undefined;             // stdin mapped to process stdin
        this.channels = 1;                  // Audio channels
        this.sampleRate = 48000;            // Audio sample rate
        this.bitDepth = 16;                 // Audio bit depth
    }
}

// Export class
module.exports._outputAudioDevice = _outputAudioDevice;