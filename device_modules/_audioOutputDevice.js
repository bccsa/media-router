// =====================================
// Base class for output devices
// 
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// External libraries
// -------------------------------------

const _device = require('./_device');
const _audioInputDevice = require('./_audioInputDevice');
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
 * @property {number} volume - Audio volume (1 = unity gain)
 * @property {number} maxVolume - Maximum volume that the client WebApp can request
 * @property {number} showVolumeControl - Indicates that the front end should show the volume control
 * @property {number} showMuteControl - Indicates that the front end should show the mute control
 * @property {number} displayOrder - Display order in the client WebApp.
 */
class _audioOutputDevice extends _device {
    constructor() {
        super();
        this.channels = 1;
        this.sampleRate = 48000;
        this.bitDepth = 16;
        this.volume = 1;
        this.maxVolume = 1.5;
        this.mute = false;
        this.showVolumeControl = true;
        this.showMuteControl = true;
        this.displayOrder = 0;
        this.clientControl = "client_AudioInputDevice";

        this._inputs = [];
        this._mixer = new Mixer({
            channels : this.channels,
            bitDepth : this.bitDepth,
            sampleRate : this.sampleRate
        });

        // Clear level and peak indicators on device stop
        this.on('run', run => {
            if (!run) {
                this._inputs.forEach(device => {
                    device._notify({level: 0, peak: 0});
                });
                this._notify({level: 0, peak: 0});
            }
        });

        // Calculate mixer volume on volume and mute updates
        this.on('volume', vol => {
            this._mixer.volume = this._getVolume(this);
        });
        this.on('mute', mute => {
            this._mixer.volume = this._getVolume(this);
        });

        // Subscribe to mixer output level indication events and notify externally.
        this._mixer.level.on('level', data => {
            this._notify({level: data})
        });
        this._mixer.level.on('peak', data => {
            this._notify({peak: data})
        });
    }

    /** 
     * Add an _audioInputDevice to the mixer 
     */
    AddInput(device) {
        // Create a new mixer input
        if (device && device.__proto__ instanceof _audioInputDevice) {
            // Add passed _audioInputDevice to list of inputs
            this._inputs.push(device);
            
            const input = this._mixer.input({
                channels : device.channels,
                bitDepth : device.bitDepth,
                sampleRate : device.sampleRate,
                volume : this._getVolume(device)
            });

            // subscribe to input device events
            device.on('volume', () => {
                input.volume = this._getVolume(device);
            });
            device.on('mute', () => {
                input.volume = this._getVolume(device);
            });

            // Subscribe to mixer input level indication events
            input.level.on('level', data => {
                device._notify({level: data})
            });
            input.level.on('peak', data => {
                device._notify({peak: data})
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

    // Get mute compensated device volume
    _getVolume(device) {
        if (device.mute) {
            return 0;
        } else {
            return device.volume;
        }
    }
}

// Export class
module.exports = _audioOutputDevice;