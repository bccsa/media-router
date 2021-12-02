// ======================================
// Base class for input devices. Includes
// an AudioMixer.Input
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

class _inputDevice extends _device {
    constructor(DeviceList) {
        super(DeviceList);
        this.stdout = undefined;            // stdout mapped to process stdout
        this.channels = 1;                  // Audio channels
        this.sampleRate = 48000;            // Audio sample rate
        this.bitDepth = 16;                 // Audio bit depth

        this.destination = "Destination device name";  // Destination device name (string)
        this.destination_pin = "stdin";                // Destination device input name (string)
        this._destination = undefined;                 // reference to source device

        // Find the destination device after 100ms
        setTimeout(() => {
            this._findDestination();
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
    _findDestination() {
        this._destination = this._deviceList.FindDevice(this.destination);

        // start and stop event chaining
        if (this._destination != undefined && this._destination.Start != undefined && this._destination.Stop != undefined) {
            this.run.on('start', () => {
                // Start the destination process after this process has started
                this._destination.Start();

                // Pipe output to destination input
                if (this.stdout != undefined) {
                    this.stdout.pipe(this._destination[this.destination_pin]);
                }
            });
            
            this.run.on('stop', () => {
                // Unipe output to destination input
                if (this.stdout != undefined && this._destination[this.destination_pin]) {
                    this.stdout.unpipe(this._destination[this.destination_pin]);
                }

                // Stop process when the destination device stopped
                this._destination.Stop();
            });
        }
        else {
            this._logEvent(`Unable to find destination device "${this.destination}"`);
            
            // Retry to find the destination device in 1 second
            setTimeout(() => { this._findDestination() }, 1000);
        }
    }
}

// Export class
module.exports._inputDevice = _inputDevice;