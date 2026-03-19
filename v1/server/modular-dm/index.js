// =====================================
// Modular Data Model for NodeJS
//
// Copyright BCC South Africa
// =====================================

const EventEmitter = require("events");

/**
 * modular-dm base class (data model base class)
 * @extends EventEmitter
 * @class
 * @constructor
 */
class dm extends EventEmitter {
    /**
     * modular-dm base class (data model base class)
     */
    constructor() {
        super();
        /**
         * The name of the class. This property should not be set in code.
         * @type {string}
         */
        this.controlType = this.constructor.name;
        /**
         * Special property indicating the name of the control. This property should not be set in code.
         * @type {string}
         */
        this._controlName = "";
        /**
         * When true, excludes this control and subsequent child controls' data from GetData() results and 'data' events.
         * @type {boolean}
         */
        this.hideData = false;
        /**
         * When set to true through SetData(), removes this control (or the child control passed to) from the DOM and from the modular-ui data model.
         * @type {boolean}
         */
        this.remove = undefined;
        /**
         * List of child controls. This should not be set in code.
         * @type {object}
         */
        this._controls = {};
        /**
         * List of properties equipped with getters and setters. This should not be set / modified in code
         * @type {object}
         */
        this._properties = {};
        /**
         * List of property access control settings.
         * @type {object}
         */
        this._acl = {};
        /**
         * Reference to the parent of this control. This should not be set in code.
         * @type {object}
         */
        this._parent = undefined;
        /**
         * Reference to the top level parent. This should not be set in code.
         * @type {object}
         */
        this._topLevelParent = undefined;
        /**
         * Special property containing the path to the modular-dm control classes.
         * @type {string}
         */
        this._path = "";
        /**
         * Used internally to bypass updates notifications through the 'data' event when properties are set by Set();
         */
        this._bypassNotify = false;
        /**
         * List of meta data properties. This metadata will be sent with the 'data' event.
         */
        this._meta = {};
    }

    // -------------------------------------
    // Overridden functions
    // -------------------------------------

    /**
     * Emit an event
     * @param {string} eventName
     * @param {*} data - Data to be emitted
     * @param {string} scope - [Optional] local: Only emit on this control; bubble: Emit on this control and all parent controls; top: Only emit on top level parent control; local_top: Emit on both this control and top level parent control; (Default: local)
     */
    emit(eventName, data, scope = "local", meta) {
        // local emit
        if (scope == "local" || scope == "local_top" || scope == "bubble") {
            super.emit(eventName, data, meta);
        }

        // parent control emit
        if (scope == "bubble" && this._parent) {
            this._parent.emit(eventName, data, scope, meta);
        }

        // top level control emit
        if (scope == "top" || scope == "local_top") {
            this._topLevelParent.emit(eventName, data, undefined, meta);
        }
    }

    /**
     * Adds the listener function to the end of the listeners array for the event named eventName. No checks are made to see if the listener has already been added. Multiple calls passing the same combination of eventNameand listener will result in the listener being added, and called, multiple times.
     * @param {string} eventName
     * @param {*} listener - callback function
     * @param {*} options - Optional: { immediate: true, caller: [caller control] } - immediate: true: (only for class property change events) Calls the 'listener' callback function immediately on subscription with the current value of the property (if existing); caller: [caller control]: Subscribes to the 'remove' event of the caller, and automatically unsubscribes from the event when the caller is removed. This helps to prevent memory uncleared references to the removed control's callback functions.
     */
    on(eventName, listener, options = {}) {
        super.on(eventName, listener);

        if (options) {
            // Call the immediate callback
            if (options.immediate && this[eventName] != undefined) {
                listener(this[eventName]);
            }

            // Automatically unsubscribe from event if the caller is removed
            if (options.caller && options.caller.on) {
                options.caller.on("remove", () => {
                    this.off(eventName, listener);
                });
            }
        }

        return listener;
    }

    /**
     * Adds a one-timelistener function for the event named eventName. The next time eventName is triggered, this listener is removed and then invoked.
     * @param {string} eventName
     * @param {*} listener - callback function
     * @param {*} options - Optional: { caller: [caller control] } - caller: [caller control]: Subscribes to the 'remove' event of the caller, and automatically unsubscribes from the event when the caller is removed. This helps to prevent memory uncleared references to the removed control's callback functions.
     */
    once(eventName, listener, options) {
        super.once(eventName, listener);

        if (options) {
            // Automatically unsubscribe from event if the caller is removed
            if (options.caller && options.caller.on) {
                options.caller.on("remove", () => {
                    this.off(eventName, listener);
                });
            }
        }

        return listener;
    }

    // -------------------------------------
    // Override Functions
    // -------------------------------------

    /**
     * Overridable method that is called directly after control creation. The [controlName] event is emitted on the control's parent directly after Init() is called. The Init() method can be overridden to add initialisation logic to extentions of the modular-dm base class.
     */
    Init() {}

    // -------------------------------------
    // Core functions
    // -------------------------------------

    /**
     * Sets a javascript data object, and updates values, creates and removes controls as applicable.
     * @param {object} data
     */
    Set(data) {
        if (data && typeof data == "object") {
            Object.keys(data).forEach((k) => {
                // Check for remove command
                if (k == "remove") {
                    if (data[k] == true) {
                        this._parent.RemoveChild(this._controlName);
                    }
                }
                // Ignore invalid and special keys
                else if (k[0] != "_" && k != "controlType") {
                    // Update this control's settable (not starting with "_") properties
                    if (
                        this[k] != undefined &&
                        (typeof this[k] == "number" ||
                            typeof this[k] == "string" ||
                            typeof this[k] == "boolean" ||
                            Array.isArray(this[k]))
                    ) {
                        if (
                            !this._acl[k] ||
                            !this._acl[k].Set ||
                            this._acl[k].Set == "public"
                        ) {
                            if (data[k] != null && data[k] != undefined) {
                                this._bypassNotify = true;
                                this[k] = data[k];
                            } else {
                                // Prevent properties to be set to undefined or null
                                this._bypassNotify = true;
                                this[k] = `${data[k]}`;
                            }
                        }
                    }
                    // Update child controls. If a child control shares the name of a settable property, the child control will not receive data.
                    else if (this._controls[k] != undefined) {
                        this._controls[k].Set(data[k]);
                    }
                    // Create a new child control if the passed data has controlType set. If this control is not ready yet (Init did not run yet),
                    else if (
                        data[k] != null &&
                        data[k].controlType != undefined
                    ) {
                        this._createControl(data[k], k);
                    }
                }
            });
        }
    }

    /**
     * Get control data as an javascript object
     * @param {Object} options - { sparse: false/true (true [default]: Do not return empty properties; false: Return empty properties;) }
     * @returns
     */
    Get(options = { sparse: true }) {
        var data = {};

        // Get own properties
        Object.getOwnPropertyNames(this._properties).forEach((k) => {
            if (
                !this._acl[k] ||
                !this._acl[k].Get ||
                this._acl[k] == "public"
            ) {
                if (
                    (options.sparse && this._properties[k] != "") ||
                    !options.sparse
                ) {
                    data[k] = this._properties[k];
                }
            }
        });

        // Get child controls properties
        Object.keys(this._controls).forEach((k) => {
            if (
                this._controls[k].Get != undefined &&
                !this._controls[k].hideData
            ) {
                data[k] = this._controls[k].Get(options);
            }
        });

        return data;
    }

    /**
     * Remove child control
     * @param {*} control - Name of the child control
     */
    RemoveChild(control) {
        if (this._controls[control] != undefined) {
            let c = this._controls[control];

            // Emit remove event
            c.emit("remove", c);

            delete this._controls[control];
            delete this[control];

            // Unregister from all events
            c.removeAllListeners();
        }
    }

    /**
     * Notifies parent control of a change to the given property or array of properties and triggers the onChange event.
     * @param {*} propertyNames - Single string or array of string property names
     */
    NotifyProperty(propertyNames) {
        let data = {};
        let meta = {};
        if (Array.isArray(propertyNames)) {
            propertyNames.forEach((p) => {
                if (
                    !this._acl[p] ||
                    !this._acl[p].Get ||
                    this._acl[p].Get == "public"
                ) {
                    if (this[p] != undefined) {
                        data[p] = this[p];
                        meta[p] = this._meta[p];
                    }
                }
            });
        } else {
            if (this[propertyNames] != undefined) {
                if (
                    !this._acl[propertyNames] ||
                    !this._acl[propertyNames].Get ||
                    this._acl[propertyNames].Get == "public"
                ) {
                    data[propertyNames] = this[propertyNames];
                    meta[propertyNames] = this._meta[propertyNames];
                }
            }
        }

        this._notify(data, meta);
    }

    /**
     * Log events to an event log (exposed as 'log' event on the top level parent)
     * @param {String} message
     */
    Log(message) {
        this._topLevelParent.emit(
            "log",
            `${this.constructor.name} | ${this._controlName}: ${message}`
        );
    }

    // notifies parent of data change, and triggers onChange event.
    _notify(data, meta) {
        if (this._parent != undefined) {
            let n = {
                [this._controlName]: data,
            };

            if (!this.hideData) {
                this._parent._notify(n, meta);
            }
        }

        this.emit("data", data, undefined, meta);
    }

    /**
     * Return an existing class from a passed string class name, or try to require the passed name (js file should have the same name)
     * @param {*} name - class name
     * @returns class
     */
    _getDynamicClass(name) {
        // adapted from https://stackoverflow.com/questions/5646279/get-object-class-from-string-name-in-javascript
        let tp = this._topLevelParent;

        if (!tp._cls_[name]) {
            // cache is not ready, fill it up
            if (name.match(/^[a-zA-Z0-9_]+$/)) {
                // proceed only if the name is a single word string
                try {
                    let p = this._path;
                    if (!this._path) p = "";
                    let c = require(`${p}/${name}`);
                    if (c) {
                        tp._cls_[name] = c;
                    }
                } catch {
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
            control._controlName = name;
            control._parent = this;
            control._path = this._path;

            // Set reference to top level parent
            control._topLevelParent = this._topLevelParent;

            // Create getters and setters
            Object.getOwnPropertyNames(control).forEach((k) => {
                // Only return settable (not starting with "_") properties excluding special properties
                if (
                    k[0] != "_" &&
                    (typeof control[k] == "number" ||
                        typeof control[k] == "string" ||
                        typeof control[k] == "boolean" ||
                        Array.isArray(control[k]))
                ) {
                    // Store property value in _properties list
                    control._properties[k] = control[k];

                    // Create getter and setter
                    Object.defineProperty(control, k, {
                        get: function () {
                            if (
                                !this._acl[k] ||
                                !this._acl[k].getter ||
                                this._acl[k].getter == "public"
                            ) {
                                return this._properties[k];
                            }
                        },
                        set: function (val) {
                            // Only notify changes
                            if (this._properties[k] != val) {
                                if (
                                    !this._acl[k] ||
                                    !this._acl[k].setter ||
                                    this._acl[k].setter == "public"
                                ) {
                                    this._properties[k] = val;
                                    if (!this._bypassNotify) {
                                        this.NotifyProperty(k);
                                    } else {
                                        this._bypassNotify = false;
                                    }
                                    this.emit(k, val);
                                }
                            }
                            this._bypassNotify = false;
                        },
                    });
                }
            });

            // Add new control to controls list
            this._controls[name] = control;

            // Add a direct reference to the control in this control
            this[name] = control;

            // Set control child data
            control.Set(data);

            // Initialise control after setting data initial data
            control.Init();

            // Emit the [controlName] event on this (newly created control's parent)
            this.emit(name, control);

            // Emit that a new control has been created
            this.emit("newChildControl", control);
        }
    }

    /**
     * Set an access control list for a property. Only applies to properties with automatically generated getters and setters (number, string, bool and Array types not prefixed with '_')
     * @param {*} propertyName - Property name
     * @param {*} ACL - Access control list { Set: 'public'(default)/'none', Get: 'public'(default)/'none', setter: 'public'(default)/'none', getter: 'public'(default)/'none' } where 'Set' refers to data set through control.Set(), 'Get' refers to data retreived through control.Get() or through automatic notification, 'setter' refers to setting the property through control.property = value and 'getter' refers to getting the property value through value = control.property. 'private' = only accessible by the control itself, 'public' = accessible by any other controls / external code, none = not accessible at all.
     */
    SetAccess(propertyName, ACL) {
        if (this[propertyName] != undefined) {
            this._acl[propertyName] = ACL;
        }
    }

    /**
     * Set a list of meta data properties. This metadata will be sent with the 'data' event.
     * @param {*} propertyName - Property name
     * @param {*} META - Meta data to be set, this can be any object structure, the way the you want to receive the data with the data event
     */
    SetMeta(propertyName, META) {
        if (this[propertyName] != undefined) {
            this._meta[propertyName] = META;
        }
    }
}

/**
 * Top level container for moduler-dm controls
 */
class dmTopLevelContainer extends dm {
    /**
     * Top level container for moduler-dm controls
     * @param {string} path - path to modular-dm control class files. This should be the absolute path to the control files directory or the relative path from the directory where modular-dm is installed.
     */
    constructor(path) {
        super();
        this._path = path;
        this._controlName = "topLevelContainer";
        this._topLevelParent = this;

        // dynamically loaded class cache
        this._cls_ = {};
    }
}

/* #region  multiple extendable classes */

/**
 * _uiClasses is a function added to modular-ui, to be able to extend a class with more that one class
 * !!! Important to note, that if both super classes contains the same porperty/ function (porperty/ function name, will be overwriten by the last class loaded containing that property/ function)
 * Link to referance used: https://stackoverflow.com/questions/29879267/es6-class-multiple-inheritance
 * @param {Object} baseClass - Base class to be extended with sub classes
 * @param  {...any} mixins - Classes to be added to the base class, (comma separated eg. uiClasses(BaseClass, ClassA, ClassB, ClassC))
 * @returns Base class
 */
function Classes(baseClass, ...mixins) {
    class base extends baseClass {
        constructor(...args) {
            super(...args);
            mixins.forEach((mixin) => {
                copyProps(this, new mixin());
            });
        }
    }
    let copyProps = (target, source) => {
        // this function copies all properties and symbols, filtering out some special ones
        Object.getOwnPropertyNames(source)
            .concat(Object.getOwnPropertySymbols(source))
            .forEach((prop) => {
                if (
                    !prop.match(
                        /^(?:constructor|prototype|arguments|caller|name|bind|call|apply|toString|length)$/
                    )
                )
                    Object.defineProperty(
                        target,
                        prop,
                        Object.getOwnPropertyDescriptor(source, prop)
                    );
            });
    };
    mixins.forEach((mixin) => {
        // outside contructor() to allow aggregation(A,B,C).staticFunction() to be called etc.
        copyProps(base.prototype, mixin.prototype);
        copyProps(base, mixin);
    });
    return base;
}
/* #endregion */

// Export class
module.exports.dm = dm;
module.exports.dmTopLevelContainer = dmTopLevelContainer;
module.exports.Classes = Classes;
