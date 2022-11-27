// =====================================
// Base class for devices
//
// Copyright BCC South Africa
// =====================================

const EventEmitter = require('events');

/**
 * Base class for device modules
 * @extends EventEmitter
 * @property {String} name - Display name
 */
class _device extends EventEmitter {
    constructor() {
        super();
        this.controlType = this.constructor.name; // The name of the class. This property should not be set in code.
        this.controls = {};                 // List of child controls
        this._parent = undefined;           // Reference to parent
        this._run = false;                  // Running status flag
        this._exitFlag = false;             // Flag to prevent auto-restart on user issued stop command
        this.displayOrder = undefined;      // Display order on client WebApp. Implementing classes should set this value to a numeric value to show it in the exported configuration.
        // this.displayWidth = undefined;      // Display width on client WebApp. Implementing classes should set this value to a string value (e.g. "80px") to show it in the exported configuration.
        this._clientVisible = false;        // If true, the device has a client UI control.

        // Subscribe to parent run event
        if (this._parent) {
            this._parent.on('run', (state) => {
                this.run = state;
            });
        }
    }

    /**
     * Start the playback process. This method should be implemented (overridden) by the inheriting class
     */
    _start() {
    }

    /**
     * Stop the playback process. This method should be implemented (overridden) by the inheriting class
     */
    _stop() {
    }

    /**
     * Get the top level parent control
     */
    get topLevelParent() {
        if (!this._topLevelParent) {
            if (this._parent) {
                this._topLevelParent = this._parent.topLevelParent;
            } else {
                this._topLevelParent = this;
            }
        }
        return this._topLevelParent;
    }

    /**
     * Return the client WebApp HTML
     */
    get clientHtmlFileName() {
        return this._clientHtmlFileName;
    }

    /**
     * Get the running status
     */
    get run() {
        return this._run;
    }

    /**
     * Set the running status (execute the _start and _stop functions) and notify event subscribers.
     */
    set run(state) {
        if (state == true && this._run != true) {
            this._run = true;
            this._start();
            this.emit('run', this._run);
        }
        else if (state == false && this.run == true) {
            this._run = false;
            this._stop()
            this.emit('run', this._run);
        }
    }

    /**
     * Set configuration
     * @param {Object} config 
     */
    SetConfig(config) {
        Object.getOwnPropertyNames(config).forEach(k => {
            // Update this control's settable (not starting with "_") properties
            if (k[0] != '_' && k != "controlType") {
                if (this[k] != undefined &&
                    (typeof this[k] == 'number' ||
                        typeof this[k] == 'string' ||
                        typeof this[k] == 'boolean' ||
                        k == "destinations")
                ) {
                    if (config[k] != null && config[k] != undefined) {
                        this[k] = config[k];
                    } else {
                        // Prevent properties to be set to undefined or null
                        this[k] = `${config[k]}`;
                    }
                }
                // Update child controls. If a child control shares the name of a settable property, the child control will not receive data.
                else if (this.controls[k] != undefined) {
                    this.controls[k].SetConfig(config[k]);
                }
                // Create a new child control if the passed data has controlType set.
                else if (config[k] != null && config[k].controlType != undefined) {
                    this._createControl(config[k], k);
                }
            }
        });
    }

    /**
     * Return an existing class from a passed string class name, or try to require the passed name (js file should have the same name)
     * @param {*} name - class name
     * @returns class
     */
    _getDynamicClass(name) {
        // adapted from https://stackoverflow.com/questions/5646279/get-object-class-from-string-name-in-javascript
        let tp = this.topLevelParent;

        // Create cache
        if (!tp._cls_) {
            tp._cls_ = {};
        }

        if (!tp._cls_[name]) {
            // cache is not ready, fill it up
            if (name.match(/^[a-zA-Z0-9_]+$/)) {
                // proceed only if the name is a single word string
                try {
                    // this._cls_[name] = eval(name);
                    let c = require(`./${name}`);
                    if (c) {
                        tp._cls_[name] = c;
                    }
                }
                catch {
                    return undefined;
                }
            } else {
                return undefined;
            }
        }
        return tp._cls_[name];
    }

    /**
     * Create a new control
     * @param {*} data - control data
     * @param {*} name - control name
     */
    _createControl(data, name) {
        let controlClass = this._getDynamicClass(data.controlType);

        if (controlClass) {
            // Create new control
            let control = new controlClass();
            control.name = name;
            control._parent = this;

            // Set control child data
            control.SetConfig(data);

            // Add new control to controls list
            this.controls[name] = control;

            // Add a direct reference to the control in this control
            this[name] = control;

            // Subscribe to this control's run event to automatically start/stop child control
            this.on('run', (state) => {
                control.run = state;
            });
        }
    }

    /**
     * Get configuration as object
     * @param {Object} options - Default: { client: false }; client -> true filters output to only include controls with _clientVisible property set.
     * @returns {Object}
     */
    GetConfig(options) {
        let data = {};

        // Get own properties
        Object.getOwnPropertyNames(this).forEach((k) => {
            // Only return settable (not starting with "_") properties
            if (
                k[0] != "_" &&
                (typeof this[k] == "number" ||
                    typeof this[k] == "string" ||
                    typeof this[k] == "boolean")
            ) {
                data[k] = this[k];
            }
        });

        // Get child controls properties
        Object.keys(this.controls).forEach((k) => {
            if (!options || !options.client || options.client && this.controls[k] && this.controls[k]._clientVisible) {
                let c = this.controls[k].GetConfig(options);
                if (c) {
                    data[k] = this.controls[k].GetConfig(options);
                }
            }
        });

        return data;
    }

    /**
     * Log events to event log (exposed as 'log' event on the top level parent)
     * @param {String} message 
     */
    _logEvent(message) {
        this.topLevelParent.emit('log', `${this.constructor.name} | ${this.name}: ${message}`);
    }

    /**
     * Notifies parent control of a change to the given property or array of properties and triggers the data event on the top level parent.
     * @param {*} propertyNames - Single string or array of string property names
     */
    NotifyProperty(propertyNames) {
        let data = {};
        if (Array.isArray(propertyNames)) {
            propertyNames.forEach((p) => {
                if (this[p] != undefined) {
                    data[p] = this[p];
                }
            });
        } else {
            if (this[propertyNames] != undefined) {
                data[propertyNames] = this[propertyNames];
            }
        }

        this._notify(data);
    }

    // notifies parent of data change, and triggers data event on the top level parent.
    _notify(data) {
        if (this._parent != undefined) {
            if (!this.hideData) {
                let n = {
                    [this.name]: data,
                };
                this._parent._notify(n);
            }
        }
        else {
            this.emit("data", data);
        }
    }
}

// Export class
module.exports = _device;