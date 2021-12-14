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

        // start and stop event chaining
        if (this._destinations[destinationName] != undefined && this._destinations[destinationName].Start != undefined && this._destinations[destinationName].Stop != undefined) {
            
            // Check if destination is an AudioMixer.
            if (this._destinations[destinationName].constructor.name == "AudioMixer") {
                // Add mixer input
                this._destinations[destinationName].AddInput(this);
            }
            else {
                // Write data to destination
                this.stdout.on('data', (data) => {
                    this._destinations[destinationName].stdin.write(data);
                });
            }
        }
        else {
            this._logEvent(`Unable to find destination device "${destinationName}"`);
            
            // Retry to find the destination device in 1 second
            setTimeout(() => { this._findDestination(destinationName) }, 1000);
        }
    }
}

// Export class
module.exports._audioTransformDevice = _audioTransformDevice;