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
const { _audioInputDevice } = require('./_audioInputDevice');
// const { PassThrough } = require ('stream');
const Mixer = require('../submodules/audio-mixer/index');

// -------------------------------------
// Class declaration
// -------------------------------------

/**
 * Base class for audio output modules. The _audioOutputDevice accepts multiple input streams, and implements an audio mixer.
 * @extends _device
 * @property {number} bitDepth - Audio bit depth (default = 14)
 * @property {number} channels - Audio channel number (default = 1)
 * @property {number} sampleRate - Audio sample rate (default = 48000)
 */
class _audioOutputDevice extends _device {
    constructor(DeviceList) {
        super(DeviceList);
        // this.stdin = new PassThrough();     // stdin mapped to process stdin
        this.channels = 1;                  // Audio channels
        this.sampleRate = 48000;            // Audio sample rate
        this.bitDepth = 16;                 // Audio bit depth

        this._inputs = [];
        this._mixer = new Mixer({
            channels : this.channels,
            bitDepth : this.bitDepth,
            sampleRate : this.sampleRate
        });
    }

    /** 
     * Add an _audioInputDevice to the mixer 
     */
    AddInput(device) {
        // Create a new mixer input
        if (device && device.__proto__ instanceof _audioInputDevice) {
            const input = this._mixer.input({
                channels : device.channels,
                bitDepth : device.bitDepth,
                sampleRate : device.sampleRate,
                volume : device.volume
            });

            // Subscribe to volume change events (to do)
            // ##########################################

            // Subscribe to level indication events (to do)
            input.on('level', data => {
                
            });

            input.on('peak', data => {
                
            });

            // Pipe device output stream to mixer input
            device.stdout.pipe(input);
        }
        else {
            if (device && device.name) {
                this._logEvent(`${this.name}: Invalid input (${device.name})`)
            }
            else {
                this._logEvent(`${this.name}: Invalid input`)
            }
        }
    }
}

// Export class
module.exports._audioOutputDevice = _audioOutputDevice;