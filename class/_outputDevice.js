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

class _outputDevice extends _device {
    constructor(DeviceList) {
        super(DeviceList);
        this.source = "Source device name"  // Source device name (string)
        this.stdin = undefined;             // stdin mapped to _aplay process stdin
        this._source = undefined;           // reference to source device
    }

    // find the source device
    _findSource() {
        this._source = DeviceList.FindDevice(this.source);

        // event subscriptions
        if (this._source != undefined) {
            this._source.run.on('start', () => {
                if (this._source.stdout != undefined) {
                    // Start process when the source device started
                    this.Start();

                    if (this.stdin != undefined) {
                        this._source.stdout.pipe(this.stdin);
                    }
                }
                else {
                    this._logEvent(`Unable to connect to "${this.source}"`);
                }
                
            });
            this._source.run.on('stop', () => {
                // Stop process when the source device stopped
                this.Stop();
            });
        }
        else {
            this._logEvent(`Unable to find source device "${this.source}"`);
            
            // Retry to find the source device in 1 second
            setTimeout(() => { this._findSource() }, 1000);
        }
    }
}

// Export class
module.exports._outputDevice = _outputDevice;