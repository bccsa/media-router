// ======================================
// Pulse-Code Modulation audio mixer
//
// Copyright BCC South Africa
// =====================================

const { _audioInputDevice } = require('./_audioInputDevice');
const Mixer = require('../submodules/audio-mixer/index');

// -------------------------------------
// Class declaration
// -------------------------------------

class AudioMixer extends _audioInputDevice {
    constructor(DeviceList) {
        super(DeviceList);
        /** Display name */
        this.name = 'New Audio Mixer'; 
        // this._ffmpeg = undefined;
        this._inputs = [];
        this._mixer = new Mixer({
            channels : this.channels,
            bitDepth : this.bitDepth,
            sampleRate : this.sampleRate
        });

        // Pipe mixer output to stdout
        this._mixer.pipe(this.stdout);

        // Emit starting status
        this.isRunning = true;
    }

    /** Not implemented */
    Start() {}

    /** Add an _audioInputDevice to the mixer */
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
                // console.log(data);
            });

            input.on('peak', data => {
                // console.log(data);
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

    /** Not implemented */
    Stop() {}
}

// Export class
module.exports.AudioMixer = AudioMixer;