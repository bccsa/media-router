// =====================================
// Base class for audio output devices
// 
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// External libraries
// -------------------------------------

const _audioDevice = require('./_audioDevice');
const _audioInputDevice = require('./_audioInputDevice');
const Mixer = require('../submodules/audio-mixer/index');

// -------------------------------------
// Class declaration
// -------------------------------------

/**
 * Base class for audio output modules. The _audioOutputDevice accepts multiple input streams, and implements an audio mixer.
 * @extends _device
 */
class _audioOutputDevice extends _audioDevice {
    constructor() {
        super();

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
            device.stdout.on('data', data => {
                input.write(data)
            })
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