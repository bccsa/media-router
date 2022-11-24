// =====================================
// Base class for output devices
// 
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
 * Audio output device base class
 * @extends _device
 * @property {number} bitDepth - Audio bit depth (default = 14)
 * @property {number} channels - Audio channel number (default = 1)
 * @property {number} sampleRate - Audio sample rate (default = 48000)
 */
class _audioOutputDevice extends _device {
    constructor(DeviceList) {
        super(DeviceList);
        this.stdin = new PassThrough();     // stdin mapped to process stdin
        this.channels = 1;                  // Audio channels
        this.sampleRate = 48000;            // Audio sample rate
        this.bitDepth = 16;                 // Audio bit depth
    }
}

// Export class
module.exports._audioOutputDevice = _audioOutputDevice;