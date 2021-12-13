// =====================================
// Base class for input devices. Includes
// an AudioMixer.Input
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

class _audioInputDevice extends _device {
    constructor(DeviceList) {
        super(DeviceList);
        this.stdout = new PassThrough();    // stdout mapped to process stdout
        this.channels = 1;                  // Audio channels
        this.sampleRate = 48000;            // Audio sample rate
        this.bitDepth = 16;                 // Audio bit depth

        this.destinations = [ "Destination device name" ];
        this._destinations = {};

        // Find the destination device after 100ms
        setTimeout(() => {
            this.destinations.forEach(destinationName => {
                this._findDestination(destinationName);
            });
        }, 100);

        // Subscribe to DeviceList start and stop events
        DeviceList.run.on('start', () => {
            this.Start();
        });

        DeviceList.run.on('stop', () => {
            this.Stop();
        });
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
                this.run.on('start', () => {
                    // Pipe to outputAudioDevice
                    // Start the destination process after this process has started
                    this._destinations[destinationName].Start();
    
                    // Pipe output to destination input
                    this.stdout.pipe(this._destinations[destinationName].stdin);
                });
                this.run.on('stop', () => {
                    if (!this._mixerInput) {
                        // Unipe output to destination input
                        this.stdout.unpipe(this._destinations[destinationName].stdin);
    
                        // Stop process when the destination device stopped
                        this._destinations[destinationName].Stop();
                    }
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
module.exports._audioInputDevice = _audioInputDevice;