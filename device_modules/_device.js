// =====================================
// Base class for devices
//
// Copyright BCC South Africa
// =====================================

const { EventEmitter } = require('events');

/**
 * Base class for device modules
 * @extends EventEmitter
 * @property {String} name - Display name
 */
class _device extends EventEmitter {
    constructor(DeviceList) {
        super();
        this.name = 'New device';           // Display name
        this._deviceList = DeviceList;      // Reference to device list
        this._isRunning = false;            // Running status flag
        this._exitFlag = false;             // Flag to prevent auto-restart on user issued stop command
        this._clientHtmlFileName = undefined;   // Reference to the client WebApp html file 
        this.displayOrder = undefined;      // Display order on client WebApp. Implementing classes should set this value to a numeric value to show it in the exported configuration.
        this.displayWidth = undefined;      // Display width on client WebApp. Implementing classes should set this value to a string value (e.g. "80px") to show it in the exported configuration.

        // Subscribe to DeviceList start and stop events
        if (DeviceList) {
            DeviceList.on('start', () => {
                this.Start();
            });
    
            DeviceList.on('stop', () => {
                this.Stop();
            });
        }
    }

    /**
     * Return the client WebApp HTML
     */
    get clientHtmlFileName() {
        return this._clientHtmlFileName;
    }


    /**
     * Event log event.
     */
    get log() {
        return this._log;
    }

    /**
     * Client UI update notifications
     */
    get clientUIupdate() {
        return this._clientUIupdate;
    }

    /**
     * Running status event. Emits 'start' and 'stop' on process start and stop.
     */
    get run() {
        return this._run;
    }

    /**
     * Get the running status
     */
    get isRunning() {
        return this._isRunning;
    }

    /**
     * Set the running status and notify event subscribers.
     */
    set isRunning(isRunning) {
        if (isRunning == true && this._isRunning != true) {
            this._isRunning = true;
            this.emit('start', this);
        }
        else if (isRunning == false && this.isRunning == true) {
            this._isRunning = false;
            this.emit('stop', this);
        }
    }

    /**
     * Set configuration
     * @param {Object} config 
     */
    SetConfig(config) {
        Object.getOwnPropertyNames(config).forEach(k => {
            // Only update "public" properties
            if (this[k] != undefined && k[0] != '_' && (typeof this[k] == 'number' || typeof this[k] == 'string' || typeof this[k] == 'boolean' || k == "destinations")) {
                this[k] = config[k];
            }
        });
    }

    /**
     * Get configuration
     * @returns {Object}
     */
    GetConfig() {
        let c = {};
        Object.getOwnPropertyNames(this).forEach(k => {
            // Only return "public" properties
            if (k[0] != '_' && (typeof this[k] == 'number' || typeof this[k] == 'string' || typeof this[k] == 'boolean' || k == "destinations")) {
                c[k] = this[k];
            }
        });
        
        return c;
    }

    /**
     * Start the playback process. This method should be implemented (overridden) by the inheriting class
     */
    Start() {
        this._exitFlag = false;   // Reset the exit flag
    }

    /**
     * Stop the playback process. This method should be implemented (overridden) by the inheriting class
     */
    Stop() {
        this._exitFlag = true;   // prevent automatic restarting of the process
    }

    /**
     * Log events to event log
     * @param {String} message 
     */
    _logEvent(message) {
        this.emit('log', `${this.constructor.name} | ${this.name}: ${message}`);
    }

    /**
     * Notify the client User Interface with status update(s)
     * @param {Object} data 
     */
    _updateClientUI(data) {
        this.emit('data', { [this.name] : data });
    }

    /**
     * Return status data needed for client user interface
     */
    GetClientUIstatus() {
        return this.GetConfig();
    }

    /**
     * Set value from client user interface
     * @param {Object} data 
     */
    SetClientUIcommand(data) {
        // To be implemented in implementing class
    }
}

// Export class
module.exports._device = _device;