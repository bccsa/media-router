// ======================================
// Base class for devices
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// External libraries
// -------------------------------------

const events = require('events');

// -------------------------------------
// Class declaration
// -------------------------------------

class _device {
    constructor(DeviceList) {
        this.name = 'New device';           // Display name
        this._deviceList = DeviceList;      // Reference to device list
        this._isRunning = false;            // Running status flag
        this._exitFlag = false;             // Flag to prevent auto-restart on user issued stop command
        this._run = new events.EventEmitter();
        this._log = new events.EventEmitter();
        this._clientHtmlFileName = undefined;   // Reference to the client WebApp html file 
        this.displayOrder = undefined;      // Display order on client WebApp. Implementing classes should set this value to a numberic value to show it in the exported configuration.
        this.displayWidth = undefined;      // Display width on client WebApp. Implementing classes should set this value to a string value (e.g. "80px") to show it in the exported configuration.
    }

    // Return the client WebApp HTML
    get clientHtmlFileName() {
        return this._clientHtmlFileName;
    }

    // Event log event.
    get log() {
        return this._log;
    }

    // Running status event. Emits 'start' and 'stop' on process start and stop.
    get run() {
        return this._run;
    }

    // Get the running status
    get isRunning() {
        return this._isRunning;
    }

    // Set the running status and notify event subscribers.
    set isRunning(isRunning) {
        if (isRunning == true && this._isRunning != true) {
            this._isRunning = true;
            this._run.emit('start', this);
        }
        else if (isRunning == false && this.isRunning == true) {
            this._isRunning = false;
            this._run.emit('stop', this);
        }
    }

    SetConfig(config) {
        Object.getOwnPropertyNames(config).forEach(k => {
            // Only update "public" properties
            if (this[k] != undefined && k[0] != '_' && (typeof this[k] == 'number' || typeof this[k] == 'string' || typeof this[k] == 'boolean')) {
                this[k] = config[k];
            }
        });
    }

    GetConfig() {
        let c = {};
        Object.getOwnPropertyNames(this).forEach(k => {
            // Only return "public" properties
            if (k[0] != '_' && (typeof this[k] == 'number' || typeof this[k] == 'string' || typeof this[k] == 'boolean')) {
                c[k] = this[k];
            }
        });

        let test = Object.getOwnPropertyDescriptors(this);
        return c;
    }

    // Start the playback process. This method should be implemented (overridden) by the inheriting class
    Start() {
        this._exitFlag = false;   // Reset the exit flag
    }

    // Stop the playback process. This method should be implemented (overridden) by the inheriting class
    Stop() {
        this._exitFlag = true;   // prevent automatic restarting of the process
    }

    // Log events to event log
    _logEvent(message) {
        this._log.emit('log', `${this.constructor.name} | ${this.name}: ${message}`);
    }
}

// Export class
module.exports._device = _device;