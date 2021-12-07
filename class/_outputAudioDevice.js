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
    }
}

// Export class
module.exports._outputAudioDevice = _outputAudioDevice;