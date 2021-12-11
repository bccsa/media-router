// =====================================
// Base class for audio transform devices
// 
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// External libraries
// -------------------------------------

const { PassThrough } = require ('stream');
const { _device } = require('./_device');

// -------------------------------------
// Class declaration
// -------------------------------------

class _audioTransformDevice extends _device {
    constructor(DeviceList) {
        super(DeviceList);

        this.stdin = undefined;             // stdin mapped to process stdin. Implementing class should define stdin.
        this.stdout = undefined;            // stdout mapped to process stdout. Implementing class should define stdout.
        this.channels = 1;                  // Audio channels
        this.sampleRate = 44100;            // Audio sample rate
        this.bitDepth = 16;                 // Audio bit depth

        this.destination = "Destination device name";  // Destination device name (string)
        this._destination = undefined;                 // reference to source device
        this._mixerInput = false;           // Flag indicating that input is a AudioMixer input

        // Find the destination device after 100ms
        setTimeout(() => {
            this._findDestination();
        }, 100);
    }

    // find the destination device
    _findDestination() {
        this._destination = this._deviceList.FindDevice(this.destination);

        // start and stop event chaining
        if (this._destination != undefined && this._destination.Start != undefined && this._destination.Stop != undefined) {
            
            // Check if destination is an AudioMixer.
            this._mixerInput = this._destination.constructor.name == "AudioMixer";
            
            if (this._mixerInput) {
                // Add destination mixer input
                this._destination.AddInput(this);
            }
            else {
                // Relay events to destination
                this.run.on('start', () => {
                    // Pipe to outputAudioDevice
                    // Start the destination process after this process has started
                    this._destination.Start();

                    // Pipe output to destination input
                    this.stdout.pipe(this._destination.stdin);
                });
                
                this.run.on('stop', () => {
                    // Unipe output to destination input
                    this.stdout.unpipe(this._destination.stdin);
    
                    // Stop process when the destination device stopped
                    this._destination.Stop();
                });
            }
        }
        else {
            this._logEvent(`Unable to find destination device "${this.destination}"`);
            
            // Retry to find the destination device in 1 second
            setTimeout(() => { this._findDestination() }, 1000);
        }
    }
}

// Export class
module.exports._audioTransformDevice = _audioTransformDevice;