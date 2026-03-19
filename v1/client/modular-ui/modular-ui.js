// =====================================
// modular-ui base classes
//
// Copyright BCC South Africa
// =====================================

// Map of element types, attributes and matching events supported for automatic data binding.
// For attributes that can be changed from the web-page, the event name is included.
// For attributes that only should be set in JavaScript (i.e removed from the element HTML), jsOnly is set to true.
// If a element type cannot be found or an attribute is not listed under the specified element type, modular-ui will try to find the attribute in _default.
const __bindingMap = {
    _default: {
        textContent: {},
        title: {},
        hidden: { jsOnly: true },
        disabled: { jsOnly: true },
    },
    a: {
        href: {},
    },
    input: {
        value: { event: "change" },
        checked: { event: "change", jsOnly: true },
        max: {},
        min: {},
        step: {},
        placeholder: {},
    },
    textarea: {
        value: { event: "change", jsOnly: true },
    },
    select: {
        value: { event: "change", jsOnly: true },
    },
    img: {
        src: {},
    },
    progress: {
        max: {},
        value: {},
    },
    video: {
        src: {},
    },
};

// Map of element types and attributes to be ignored
const __ignoreMap = {
    elements: {},
    attributes: {
        for: true,
    },
};

/* #region  Dispatcher Event */
// Code adapted from https://labs.k.io/creating-a-simple-custom-event-system-in-javascript/
class DispatcherEvent {
    constructor(eventName) {
        this.eventName = eventName;
        this.callbacks = [];
    }

    registerCallback(callback, once) {
        this.callbacks.push({ callback: callback, once: once });
    }

    unregisterCallback(callback) {
        const index = this.callbacks.findIndex((c) =>
            Object.is(c.callback, callback)
        );
        if (index > -1) {
            this.callbacks.splice(index, 1);
        }
    }

    unregisterAll() {
        this.callbacks.splice(0, this.callbacks.length);
    }

    fire(data) {
        const callbacks = this.callbacks.slice(0);
        var once = [];
        callbacks.forEach((c) => {
            c.callback(data);
            if (c.once) {
                once.push(c);
            }
        });

        // Unregister callbacks for all "once" events
        once.forEach((c) => {
            this.unregisterCallback(c.callback);
        });
    }
}

// code adapted from https://labs.k.io/creating-a-simple-custom-event-system-in-javascript/
class Dispatcher {
    constructor() {
        this.events = {};
    }

    /**
     * Emit an event
     * @param {string} eventName
     * @param {*} data
     */
    emit(eventName, data) {
        const event = this.events[eventName];
        if (event) {
            event.fire(data);
        }
    }

    /**
     * Subscribe to event
     * @param {string} eventName
     * @param {*} callback
     */
    on(eventName, callback) {
        let event = this.events[eventName];
        if (!event) {
            event = new DispatcherEvent(eventName);
            this.events[eventName] = event;
        }
        event.registerCallback(callback);
    }

    /**
     * Subscribe to the event only for one fire
     * @param {string} eventName
     * @param {*} callback
     */
    once(eventName, callback) {
        let event = this.events[eventName];
        if (!event) {
            event = new DispatcherEvent(eventName);
            this.events[eventName] = event;
        }
        event.registerCallback(callback, true);
    }

    /**
     * Depreciated. Use once()
     * @param {*} eventName
     * @param {*} callback
     */
    one(eventName, callback) {
        this.once(eventName, callback);
    }

    /**
     * Unsubscribe from event
     * @param {string} eventName
     * @param {*} callback
     */
    off(eventName, callback) {
        const event = this.events[eventName];
        event.unregisterCallback(callback);
        if (event.callbacks.length === 0) {
            delete this.events[eventName];
        }
    }

    /**
     * Unsubscribe from all events.
     */
    clearEvents() {
        Object.values(this.events).forEach((e) => {
            e.unregisterAll();
        });
    }
}
/* #endregion */

/* #region  modular-ui base class */
/**
 * modular-ui base class
 */
class ui extends Dispatcher {
    /**
     * modular-ui base class
     * @property {string} name - Special property indicating the name of the control. This property should not be set in code.
     * @property {string} controlType - The name of the class. This property should not be set in code.
     * @property {string} parentElement - Reference object name of the HTML element in which child controls should be added. Default: "_controlsDiv".
     * @property {boolean} hideData - When true, excludes this control and subsequent child controls' data from GetData() results and 'data' events.
     * @property {boolean} remove - When set to true through SetData(), removes this control (or the child control passed to) from the DOM and from the modular-ui data model.
     * @property {string} cssText - CSS style text to be applied to the control's containing HTML element (div).
     * @property {string} cssClass - CSS class or list of space separated classes to be applied to the control's containg HTML element (div).
     * @property {boolean} visible - Sets the control's visibility in the DOM. Visibility is controlled by setting the "display" CSS parameter of the control's containing HTML element (div) according to the customisable values "control.visibleDisplayCss" and "control.hiddenDisplayCss". Default: true.
     * @property {string} visibleDisplayCss - Visible CSS display setting. Default: "inherit".
     * @property {string} hiddenDisplayCss - Hidden CSS display setting. Default: "none".
     */
    constructor() {
        super();
        this.name = "controlName"; // Special property indicating the name of the control. This cannot be changed in runtime.
        this._path = ""; // Special property containing the path to the modular-ui control classes.
        this.controlType = this.constructor.name; // The name of the class. This property should not be set in code.
        this._parent = undefined; // Reference to the parent control (if any)
        this._topLevelParent = undefined; // Reference to the top level parent. Undefined if this control is the top level parent.
        this._element = document.createElement("div"); // Control's top level element. All custom html is added inside this element (see get html())
        this._controls = {}; // List of child controls
        this._properties = {}; // List of properties populated for properties with getters and setters
        this._controlsQueue = []; // Queue child controls to be created
        this._htmlControlQueue = []; // Queue child controls to be initialized while this control is not yet initialized
        this._styles = []; // Add css style paths to this array
        this._appliedStyles = []; // List of applied CSS style sheets
        this._pendingScripts = {}; // List of controls waiting for the loaded script to be applied
        this._htmlElementQueue = {}; // List of controls waiting to be be added to the DOM.
        this._uuid = this._generateUuid(); // Unique ID for this control
        this._init = false; // True when the control has been initialized (DOM linkup complete)
        this._elementIdQueue = []; // List of element object names (to be added as class properties) and element ID's
        this._elementAttributeQueue = []; // List of element attributes to be bound to class properties
        this.parentElement = "_controlsDiv"; // Reference object name of the HTML element in which child controls should be added.
        this.hideData = false; // Set to true if the control's data should be excluded from GetData() and from _notify();
        this.remove = undefined; // When control.remove : true is passed to the control via SetData(), the control is removed by it's parent.
        this.cssText = ""; // CSS style to be applied to the control's containing element.
        this.cssClass = ""; // CSS class or list of space separated classes to be applied to the control's containg element.
        this.visible = true; // Visibility of the control.
        this._element.id = this._uuid;
        this.visibleDisplayCss = "inherit"; // Visible css display setting.
        this.hiddenDisplayCss = "none"; // Hidden css display setting.
        this._elementPollCounter = 0; // Counter used by fallbackTimer when polling if container element is added to the DOM

        // Hide control's containing html div element on creation
        this._element.style.display = "none";
        this.orderBy = ""; // Property name by which the child controls should be sorted. Sorting is currently only supported in the default child controls element (_controlsDiv).
        this.orderAsc = true; // true: Sort asceding. False, sort decending. Sorting is currently only supported in the default child controls element (_controlsDiv).
        this._sorted = []; // Internal array used for sorting of sortable child controls. (Sortable = contains a property with name as per orderBy value)
        this._sortVal = ""; // Internal sort property string value
        this.__sortCallback; // Internal reference to a control's sorting callback
        this._orderByPrev = ""; // Internal previous orderBy property value to keep track of changes
        /**
         * Used internally to bypass updates notifications through the 'data' event when properties are set by Set();
         */
        this._bypassNotify = false;
        /**
         * Internal property used to store filter function set through this.filter();
         */
        this._filterFunction = undefined;
        /**
         * Internal list for keeping track of filter property monitor event subscriptions
         */
        this._filterMonitorProperties = {};
        /**
         * Cached property event callbacks used by the parent's parent.filter() function
         */
        this._filterCallbacks = {};
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
     * @param {object} meta - [Optional] Meta data to be sent with the event
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
     * @param {*} options - Optional: { immediate: true, caller: [caller control] } - immediate: true: (only for class property change events) Calls the 'listener' callback function immediately on subscription with the current value of the property (if existing); caller: [caller control]: Subscribes to the 'remove' event of the caller, and automatically unsubscribes from the event when the caller is removed. This helps to prevent uncleared references to the removed control's callback functions.
     * @returns - Returns a reference to passed callback (listener) function.
     */
    on(eventName, listener, options) {
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
     * @returns - Returns a reference to passed callback (listener) function.
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
    // Override Getters & setters
    // -------------------------------------

    /**
     * Override this getter in the implementing class
     */
    get html() {
        return `
      <div id="${this._uuid}_main"  >
        <!-- ${this.name} -->
        <div id="${this._uuid}_controls"></div>
      </div>`;
    }

    // -------------------------------------
    // Override Functions
    // -------------------------------------

    /**
     * Implementing class should override this function
     * This function is called by the parent control when the child's (this control) html has been printed to the DOM.
     */
    Init() {
        this._mainDiv = document.getElementById(`${this._uuid}_main`);

        // Element containing child controls. Controls that should not be able to host child controls
        // should not include this line.
        this._controlsDiv = document.getElementById(`${this._uuid}_controls`);
    }

    /**
     * Depreciated. Controls now includes a containing HTML element which modular-ui identifies automatically, and which is used to remove the control's HTML from the DOM.
     */
    RemoveHtml() {
        this._element.remove();
    }

    // -------------------------------------
    // Core functions
    // -------------------------------------

    /**
     * Gets a list of child controls
     */
    get childControls() {
        return this._controls;
    }

    /**
     * Sets a javascript data object, and updates values, creates and removes controls as applicable.
     * @param {object} data - Object data to be set
     */
    Set(data) {
        if (data && typeof data == "object") {
            Object.keys(data).forEach((k) => {
                // Check for remove command
                if (k == "remove") {
                    if (data[k] == true) {
                        this._parent.RemoveChild(this.name);
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
                        if (data[k] != null && data[k] != undefined) {
                            this._bypassNotify = true;
                            this[k] = data[k];
                        } else {
                            // Prevent properties to be set to undefined or null
                            this._bypassNotify = true;
                            this[k] = `${data[k]}`;
                        }
                    }
                    // Update child controls. If a child control shares the name of a settable property, the child control will not receive data.
                    else if (this._controls[k] != undefined) {
                        this._controls[k].Set(data[k]);
                    }
                    // Create a new child control if the passed data has controlType set. If this control is not ready yet (Init did not run yet),
                    // add new child controls to a controls queue.
                    else if (
                        data[k] != null &&
                        data[k].controlType != undefined
                    ) {
                        // Wait 1ms before creating the control to prevent "freezing up" the browser (gives the event Javascript loop time to process other logic).
                        setTimeout(() => {
                            this._createControl(data[k], k);
                        }, 1);
                    }
                }
            });
        }
    }

    /**
     * Depreciated. Use Set().
     */
    SetData(data) {
        return this.Set(data);
    }

    /**
     * Create a new control from data
     * @param {object} data - Control data structure. (May include child controls.)
     * @param {string} name - Control name
     */
    async _createControl(data, name) {
        // Pre-load script
        this._loadScript(data.controlType).catch((err) => {
            console.log(err);
        });

        // Add to queue
        this._controlsQueue.push({ data: data, name: name });

        // Only start processing with first control. Subsequent controls will be processed from the queue
        if (this._controlsQueue.length == 1) {
            // Process queue
            while (this._controlsQueue.length > 0) {
                let c = this._controlsQueue[0];

                // Check if control already exists. This is needed to prevent creation of duplicate controls if SetData() is executed more than once for the same control, resulting in more than one control in the _controlsQueue.
                if (this._controls[c.name]) {
                    // Set control child data
                    this._controls[c.name].Set(c.data);
                } else {
                    // Child control does not exist: continue to create control.
                    let controlClass = this._getDynamicClass(
                        c.data.controlType
                    );

                    // Load script if class does not exists
                    if (!controlClass) {
                        await this._loadScript(c.data.controlType)
                            .then((result) => {
                                if (result) {
                                    controlClass = this._getDynamicClass(
                                        c.data.controlType
                                    );
                                }
                            })
                            .catch((err) => {
                                console.log(err);
                            });
                    }

                    // Check that the class is loaded
                    if (controlClass) {
                        // Create new control
                        let control = new controlClass();
                        control.name = c.name;
                        control._parent = this;
                        control._path = this._path;

                        // Set reference to top level parent
                        if (this._topLevelParent) {
                            control._topLevelParent = this._topLevelParent;
                        } else {
                            control._topLevelParent = this;
                        }

                        // Apply css style sheets_controlsQueue
                        control._styles.forEach(async (s) => {
                            await this.ApplyStyle(s);

                            // To do: test if styles are loaded before continuing.
                        });

                        // Create getters and setters
                        Object.getOwnPropertyNames(control).forEach((k) => {
                            // Only return settable (not starting with "_") properties
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
                                        return this._properties[k];
                                    },
                                    set: function (val) {
                                        // Only emit property changes
                                        if (this._properties[k] != val) {
                                            this._properties[k] = val;
                                            if (!this._bypassNotify) {
                                                this.NotifyProperty(k);
                                            } else {
                                                this._bypassNotify = false;
                                            }
                                            this.emit(k, val);
                                        } else {
                                            this._bypassNotify = false;
                                        }
                                    },
                                });
                            }
                        });

                        // Add new control to controls list
                        this._controls[c.name] = control;

                        // Add a direct reference to the control in this control
                        this[c.name] = control;

                        // Subscribe to the orderBy and orderAsc events on child controls (used for sorting their child controls)
                        control.on("orderBy", this._order.bind(control), {
                            caller: control,
                        });
                        control.on("orderAsc", this._order.bind(control), {
                            caller: control,
                        });

                        // Check if sorting is enabled on the parent (this)
                        let orderBy = this.orderBy;
                        let subscribeChildOrderProp;
                        if (
                            (orderBy && c.data[orderBy] != undefined) ||
                            (control[orderBy] != undefined &&
                                !c.data._parentElement) ||
                            (c.data._parentElement == "_controlsDiv" &&
                                !control._parentElement) ||
                            control._parentElement == "_controlsDiv"
                        ) {
                            // Add sortable string value
                            if (c.data[orderBy] != undefined) {
                                if (typeof c.data[orderBy] == "number") {
                                    control._sortVal = c.data[orderBy];
                                } else {
                                    control._sortVal = c.data[orderBy]
                                        .toString()
                                        .toLowerCase();
                                }
                            } else {
                                // handle cases where orderBy property value is excluded due to sparse data.
                                if (typeof c.data[orderBy] == "number") {
                                    control._sortVal = control[orderBy];
                                } else {
                                    control._sortVal = control[orderBy]
                                        .toString()
                                        .toLowerCase();
                                }
                            }

                            // Calculate index for inserting in _sorted array
                            let insertIndex;
                            if (this.orderAsc) {
                                insertIndex = this._sorted.findIndex(
                                    (t) => t._sortVal > control._sortVal
                                );
                            } else {
                                insertIndex = this._sorted.findIndex(
                                    (t) => t._sortVal < control._sortVal
                                );
                            }
                            if (insertIndex < 0)
                                insertIndex = this._sorted.length;

                            // Insert into the _sorted array
                            this._sorted.splice(insertIndex, 0, control);

                            subscribeChildOrderProp = true;
                        }

                        // Set control child data
                        control.Set(c.data);

                        // Subscribe to the child control's order property after control.Set() to avoid triggering prop event on control creation (sorting on control creation is handled by _addHtml())
                        if (subscribeChildOrderProp) {
                            control.__sortCallback = function () {
                                this._orderSingle(control);
                            }.bind(this);
                            control.on(orderBy, control.__sortCallback, {
                                caller: this,
                            });
                        }

                        // Control interal event subscriptions. Event subscriptions deliberately are done after control data is set
                        // (i.e. they will not emit on control creation).
                        // This is done to prevent unexpected behavior before the control is completely initialised. Any initial values are
                        // set individually where needed.
                        control.on("visible", (visible) => {
                            if (visible) {
                                control._show();
                            } else {
                                control._hide();
                            }
                        });
                        this.on("cssText", (val) => {
                            element.style.cssText = val;
                        });
                        this.on("cssClass", (val) => {
                            element.className = val;
                        });

                        // Determine destination element
                        let e = "_controlsDiv"; // default div
                        if (
                            c.data.parentElement &&
                            typeof c.data.parentElement === "string"
                        ) {
                            e = c.data.parentElement;
                        }

                        // Initialize child controls, or add to html controls queue if this control is not initialized yet
                        if (!this._init) {
                            this._htmlControlQueue.push(control);
                        } else {
                            this._addHtmlQueue(control);
                        }
                    }
                }

                // Remove control from queue
                this._controlsQueue.shift();
            }
        }
    }

    /**
     * Add control to _addHtml queue
     * @param {object} control - Control to be added
     */
    _addHtmlQueue(control) {
        if (control != undefined && control.name != undefined) {
            // Create queue for the passed element
            if (this._htmlElementQueue[control.parentElement] == undefined) {
                this._htmlElementQueue[control.parentElement] = [];
            }

            this._htmlElementQueue[control.parentElement].push(control);

            if (this._htmlElementQueue[control.parentElement].length == 1) {
                // This is the first control to be added to the element. Start the _addHtml loop
                this._addHtml(control.parentElement);
            }
        } else {
            console.log(
                `Unable to add control "${control.name}" to element "${control.parentElement}"`
            );
        }
    }

    /**
     * Adds HTML to the giving element from the initMutationCache
     * @param {string} element - Element object name
     */
    _addHtml(element) {
        try {
            let control = this._htmlElementQueue[element][0];
            let parentControl = this;
            let observer;

            // Wait for HTML to be printed in the element before initializing control
            // Fallback timer as workaround when mutation observer is not triggering (sometimes occurs when Chrome dev-tools is open)
            let fallbackTimer = setInterval(() => {
                // Try counter
                control._elementPollCounter += 1;

                // Check if containing element exists in DOM
                if (document.getElementById(control._element.id)) {
                    console.log(
                        `Falling back to polling mechanism for control "${control.name}"`
                    );
                    this._htmlInit(
                        observer,
                        parentControl,
                        element,
                        control,
                        fallbackTimer
                    );
                }
                // Element not created. Stop polling
                else if (control._elementPollCounter >= 10) {
                    // Stop fallback interval timer and mutation observer
                    if (observer) observer.disconnect();
                    clearInterval(fallbackTimer);
                    delete control._elementPollCounter;
                    console.log(
                        `Unable to add HTML to element "${element}" in control "${parentControl.name}". Element ID not found in DOM.`
                    );
                }
            }, 20);

            // Mutation observer
            observer = new MutationObserver(function (mutationsList, observer) {
                parentControl._htmlInit(
                    observer,
                    parentControl,
                    element,
                    control,
                    fallbackTimer
                );
            });

            // Observe controls element for changes to contents
            observer.observe(parentControl[element], {
                childList: true,
                attributes: false,
            });

            // Parse control html
            let p = this._parseHtml(control);

            // Add element ids for data binding
            control._elementIdQueue.push(...p.idData);

            // Add element attributes for data binding
            control._elementAttributeQueue.push(...p.elementData);

            // Print HTML of child control into it's own top level element
            control._element.innerHTML = p.html;

            // Check if sorting is enabled
            if (parentControl.orderBy) {
                // Sorted list if initialized sibling controls and this control
                let sorted = parentControl._sorted.filter(
                    (f) => f._init || f.name == control.name
                );

                // Get control index position
                let i = sorted.findIndex((t) => t.name == control.name);
                if (sorted.length <= 1 || i >= sorted.length - 1 || i < 0) {
                    // Add the child control's top level element to the end of the parent's controls div
                    parentControl[element].appendChild(control._element);
                } else {
                    let nextControl = parentControl[sorted[i + 1].name];
                    // Insert the child control's top level element in it's sorted position
                    parentControl[element].insertBefore(
                        control._element,
                        nextControl._element
                    );
                }
            } else {
                // Add the child control's top level element to the parent's controls div
                parentControl[element].appendChild(control._element);
            }
        } catch (error) {
            console.log(
                `Unable to add HTML to element "${element}" in control "${this.name}". ${error.message}`
            );
        }
    }

    // Initialize control after added to the DOM
    _htmlInit(observer, parentControl, element, control, fallbackTimer) {
        // Disconnect mutation observer and stop fallback interval timer
        observer.disconnect();
        clearInterval(fallbackTimer);
        delete control._elementPollCounter;

        // Data bind values from @{identifier} tags
        control._createDataBindings();

        // Apply css to the control's containing _element
        control._element.style.cssText = control.cssText;
        control._element.className = control.cssClass;
        control._visibleDisplayCss = control._element.style.display;

        // Set initial visibility
        if (control.visible) {
            if (parentControl._filterFunction) {
                if (parentControl._filterFunction(control)) {
                    control._show();
                } else {
                    control._hide();
                }
            } else {
                control._show();
            }
        } else {
            control._hide();
        }

        // Subscribe to filter property events for newly created controls
        Object.keys(parentControl._filterMonitorProperties).forEach(
            (propertyName) => {
                control._filterCallbacks[propertyName] = control.on(
                    propertyName,
                    () => {
                        if (
                            parentControl._filterFunction &&
                            parentControl._filterFunction(control)
                        ) {
                            control._show();
                        } else {
                            control._hide();
                        }
                    },
                    { caller: parentControl }
                );
            }
        );

        // Run (overridden) control initialisation logic
        control.Init();
        control._init = true;

        // Notify that initialization is done
        control.emit("init", control);
        parentControl.emit(control.name, control);
        parentControl.emit("newChildControl", control);

        // Remove control from the queue
        parentControl._htmlElementQueue[element].shift();

        // Add html of subsequent controls in the queue
        if (
            parentControl._htmlElementQueue[element] != undefined &&
            parentControl._htmlElementQueue[element].length > 0
        ) {
            parentControl._addHtml(element);
        }

        // Add queued child controls
        while (control._htmlControlQueue.length > 0) {
            control._addHtmlQueue(control._htmlControlQueue.shift());
        }
    }

    _htmlPollElementId(id) {
        document.getElementById(id);
    }

    /**
     * Checks if the passed object is an array.
     * @returns Array with passed array elements. If passed element is not an array, passes an array with one element.
     */
    __array(data) {
        if (data != null && data != undefined) {
            if (Array.isArray(data)) {
                return data;
            } else {
                let a = [];
                a.push(data);
                return a;
            }
        } else {
            return [];
        }
    }

    /**
     * Parse html of a control, and creates properties for parsed elements identified with @{identifier} tags.
     * Currently only html element id's are supported.
     * @param {string} html
     * @returns {Object} - Object with modified html (identifier tags replaced with unique ID's) and data binding data.
     */
    _parseHtml(control) {
        var html = control.html;
        let eDataList = []; // element data list
        let idList = {}; // id list

        // Extract HTML elements with class properties inserted with @{identifier} tags
        let eList = this.__array(
            html.match(
                /<[^<]*>[ |\t|\n]*@{[_a-zA-Z0-9]*}[ |\t|\n]*<\/[^<]*>|<[^<]*@{[_a-zA-Z0-9]*}[^<]*(>[^>]*<\/[^<]*>|[\/]?>)/gim
            )
        );
        eList.forEach((elementHtml) => {
            var elementHtml_new = elementHtml;

            // Extract the element type
            let eType = this.__array(elementHtml.match(/^<[a-zA-Z]*[0-9]?/gim));
            if (eType.length > 0) {
                eType = eType[0].replace("<", "").toLowerCase();
            } else {
                console.log(
                    `${control.name}: Unable to parse element: Element type not set.`
                );
                return;
            }

            // Ignore elements in ignore map
            if (__ignoreMap.elements[eType]) return;

            // Element data
            let eData = { elementType: eType, attributes: {} };

            let tagList = [];

            // Extract all instances of @{identifier} tags
            this.__array(
                elementHtml.match(
                    /[a-zA-Z]*\=["|']?@{[_a-zA-Z0-9]*}|>[ |\t|\n]*@{[_a-zA-Z0-9]*}[ |\t|\n]*</gim
                )
            ).forEach((tData) => {
                // Get attribute type
                let aType = this.__array(tData.match(/[a-zA-Z]+=/gim));
                if (aType.length > 0) {
                    aType = aType[0].replace("=", "");
                } else {
                    aType = "textContent";
                }

                // Ignore attributes in ignore map
                if (__ignoreMap.attributes[aType]) return;

                // Get the indentifier tag
                let tag = this.__array(tData.match(/@{[_a-zA-Z0-9]*}/gim))[0]
                    .replace("@{", "")
                    .replace("}", "");
                tagList.push(tag);

                // Add attribute
                if (!eData.attributes[aType]) {
                    eData.attributes[aType] = tag;
                } else {
                    console.log(
                        `${control.name}: Unable to link property "${tag}" to element "${eType}" attribute "${aType}": duplicate attribute`
                    );
                }
            });

            if (!eData.attributes.id) {
                // Check element for existing (invalid) ID
                if (elementHtml.match(/[ |\t]+id=/gim)) {
                    console.log(
                        `${control.name}: Unable to link properties to element "${eType}": Invalid element ID - ID not an @{identifier} tag)`
                    );
                    return;
                } else {
                    // Create element ID if element does not have an ID specified
                    // Use the same name for the element object reference (to be created) and the element id
                    let id = `${control._uuid}_id_${this._generateUuid()}`;
                    eData.attributes.id = id;
                    idList[id] = id;

                    elementHtml_new = elementHtml_new.replace(
                        /^<[a-zA-Z]*/gim,
                        `<${eType} id="${id}"`
                    );
                }
            } else if (!idList[eData.attributes.id]) {
                idList[
                    eData.attributes.id
                ] = `${eData.attributes.id}_${control._uuid}`;
            }

            // Remove JavaScript only attributes from HTML
            Object.keys(eData.attributes).forEach((attribute) => {
                if (
                    __bindingMap[eType] &&
                    __bindingMap[eType][attribute] &&
                    __bindingMap[eType][attribute].jsOnly
                ) {
                    // Update element html
                    let r = new RegExp(
                        `${attribute}=[ |\t]*["|']?@\{${eData.attributes[attribute]}\}["|']?`,
                        "gmi"
                    );
                    elementHtml_new = elementHtml_new.replace(r, "");
                }
            });

            // Update element with tag values
            //      filter unique values tags assigned to the element ID
            tagList
                .filter((v, i, a) => a.indexOf(v) === i)
                .filter((t) => t != eData.attributes.id)
                .forEach((tag) => {
                    // Validate tag
                    if (control[tag] != undefined) {
                        // Update element html
                        let r = new RegExp(`@\{${tag}\}`, "gmi");
                        elementHtml_new = elementHtml_new.replace(
                            r,
                            control[tag]
                        );
                    }
                });

            // Update html with updated element
            html = html.replace(elementHtml, elementHtml_new);

            eDataList.push(eData);
        });

        // Replace all id @{identifier} tags with the generated element id's
        let idArr = [];
        Object.keys(idList).forEach((id) => {
            let r = new RegExp(`@\{${id}\}`, "gmi");
            html = html.replace(r, idList[id]);

            // Convert id list to array
            idArr.push({ id: id, elementID: idList[id] });
        });

        return { html: html, idData: idArr, elementData: eDataList };
    }

    /**
     * Create data bindings from @{identifier} tags
     */
    _createDataBindings() {
        // Create element references
        while (this._elementIdQueue.length > 0) {
            let i = this._elementIdQueue.shift();
            if (this[i.id] == undefined) {
                this[i.id] = document.getElementById(i.elementID);
                if (!this[i.id]) {
                    console.log(
                        `${this.name}: Unable to create element reference "${i.id}": Element not found`
                    );
                }
            } else {
                console.log(
                    `${this.name}: Unable to create element reference "${i.id}": Class property already exists`
                );
            }
        }

        // Attribute data binding
        while (this._elementAttributeQueue.length > 0) {
            let eData = this._elementAttributeQueue.shift();

            Object.keys(eData.attributes).forEach((a) => {
                let prop = eData.attributes[a]; // Property name
                let elem = this[eData.attributes.id]; // Element reference

                // Subscribe to element changes for supported elements
                this._bind(eData.elementType, elem, a, prop);
            });
        }
    }

    /**
     * Bind a property value to an element attribute. Changes are also notified
     * @param {*} elementType
     * @param {*} element
     * @param {*} attribute
     * @param {*} property
     */
    _bind(elementType, element, attribute, property) {
        if (
            attribute != "id" &&
            (typeof this[property] != "object" || Array.isArray(this[property]))
        ) {
            let e = elementType;
            // Set element type to _default if element + attribute combination is not found in map.
            if (!__bindingMap[e] || !__bindingMap[e][attribute]) e = "_default";

            if (__bindingMap[e] && __bindingMap[e][attribute]) {
                // Set initial value for JavaScript only attributes
                if (__bindingMap[e][attribute].jsOnly)
                    element[attribute] = this[property];

                this.__bind(
                    element,
                    attribute,
                    __bindingMap[e][attribute].event,
                    property
                );
            } else {
                console.log(
                    `${this.name}: Unable to bind element "${elementType}" attribute "${attribute}" to property "${property}": Unsupported attribute`
                );
            }
        }
    }

    __bind(element, attribute, event, property) {
        // Flags to prevent double events
        let block1 = false;
        let block2 = false;

        // Subscribe to property change
        this.on(property, (val) => {
            if (!block1) {
                block2 = true;
                element[attribute] = val;
                block2 = false;
            }
        });

        if (event) {
            if (!element || !element.addEventListener) {
                console.log(
                    `${this.name}: Unable to add event listner "${event}" for property "${property}": Invalid element`
                );
                return;
            }
            // Subscribe to element event
            element.addEventListener(event, () => {
                if (!block2) {
                    // Parse value
                    let v;
                    switch (typeof this[property]) {
                        case "string":
                            v = element[attribute].toString();
                            break;
                        case "number":
                            v = Number.parseFloat(
                                element[attribute].toString()
                            );
                            break;
                        case "boolean":
                            v = element[attribute].toString() === "true";
                            break;
                        default:
                            console.log(
                                `${this.name}: Unable to process element changes "${event}" for property "${property}": Unsupported property type (property not string, number or boolean)`
                            );
                            break;
                    }

                    if (v != undefined) {
                        block1 = true;
                        this[property] = v;
                        block1 = false;
                    } else {
                        console.log(
                            `${this.name}: Unable to process element changes "${event}" for property "${property}": Invalid value (value not string, number or boolean)`
                        );
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
                (options.sparse && this._properties[k] != "") ||
                !options.sparse
            ) {
                data[k] = this._properties[k];
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
     * Depreciated. Use Get().
     */
    GetData(options = { sparse: true }) {
        return this.Get(options);
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

            this._controls[control].RemoveHtml();
            delete this._controls[control];
            delete this[control];

            let sortedIndex = this._sorted.findIndex((t) => t.name == c.name);
            if (sortedIndex >= 0) this._sorted.splice(sortedIndex, 1);

            // Unregister from all events
            c.clearEvents();
        }
    }

    /**
     * Apply a CSS stylesheet to the DOM
     * @param {*} ref - URL or reference to the stylesheet file
     */
    ApplyStyle(ref) {
        return new Promise((resolve, reject) => {
            if (!this._appliedStyles.includes(ref)) {
                this._appliedStyles.push(ref);
                if (this._parent != undefined) {
                    return this._parent.ApplyStyle(ref);
                } else {
                    let l = document.styleSheets.length;
                    let t = setInterval(() => {
                        if (document.styleSheets.length > l) {
                            resolve();
                            clearInterval(t);
                        }
                    }, 10);

                    // ref https://stackoverflow.com/questions/11833759/add-stylesheet-to-head-using-javascript-in-body
                    let head = document.head;
                    let link = document.createElement("link");

                    link.type = "text/css";
                    link.rel = "stylesheet";
                    link.href = this._path + "/" + ref;

                    head.appendChild(link);
                }
            } else {
                resolve();
            }
        });
    }

    /**
     * Load the javascript file for the passed data.controlType. Re-applies the passed data to the callerControl when the script has been loaded so that the callerControl can create the child control.
     * @param {string} className - name of the control class (script file name excluding extension)
     * @returns {Promise} - Returns a promise with a true / false result indicating if the script has been loaded successfully
     */
    _loadScript(className) {
        if (this._getDynamicClass(className)) {
            return new Promise((resolve, reject) => {
                // Resolve empty promise indicating that no new class was loaded
                resolve();
            });
        } else {
            if (this._parent != undefined) {
                // Pass the request to the top level parent
                return this._parent._loadScript(className);
            } else {
                return new Promise(async (resolve, reject) => {
                    // Subscribe to the _scriptLoad event
                    this.once(`_scriptLoad_${className}`, (result) => {
                        resolve(result);
                    });

                    // Only process first request
                    if (!this._pendingScripts[className]) {
                        this._pendingScripts[className] = true;

                        try {
                            // Download script file to check if script extends another class
                            let scriptFile;
                            await fetch(this._path + "/" + className + ".js")
                                // Catch fetch error's (https://stackoverflow.com/questions/39297345/fetch-resolves-even-if-404)
                                .then((res) => {
                                    if (!res.ok) {
                                        throw new Error("");
                                    } else {
                                        scriptFile = res;
                                    }
                                })
                                .catch((err) => {
                                    throw new Error("");
                                });
                            let text = await scriptFile.text();

                            // Match class with extend keyword
                            let match = text.match(
                                /class[\t_a-zA-Z0-9 ]*extends.*{/gm
                            );
                            if (Array.isArray(match)) {
                                match = match[0];
                            }

                            if (match) {
                                // Extract extended class name
                                match = match.replace(
                                    /class[\t_a-zA-Z0-9 ]*extends[ \t\n]*/gm,
                                    ""
                                );
                                match = match.replace(/[\t_ \n]*{/gm, "");
                                match = match.replace(/_uiClasses/m, "");
                                match = match.replace(/[^a-zA-Z0-9_ ]/gm, " ");
                                match = match.split(/\s+/gm);
                                if (match.length > 0) {
                                    let _p = [];
                                    match.forEach(async (m) =>
                                        _p.push(
                                            new Promise(async (resolve) => {
                                                m &&
                                                    (await this._loadScript(m));
                                                resolve();
                                            })
                                        )
                                    );
                                    await Promise.all(_p);
                                }
                            }

                            // Load script
                            const script = document.createElement("script");
                            script.type = "text/javascript";

                            // Create child controls when the script is done loading
                            script.onload = () => {
                                // Delete the pending controls flag
                                delete this._pendingScripts[className];

                                // fire _scriptLoad event
                                this.emit(`_scriptLoad_${className}`, true);
                            };

                            // Set script path including the root path passed to the top level parent element
                            script.src = this._path + "/" + className + ".js";

                            // Ignore reject error's
                            var rejectHandler = (event) => {};
                            script.addEventListener("error", rejectHandler);

                            // Add to DOM head
                            document.head.appendChild(script);
                        } catch (err) {
                            console.log(
                                `Unable to load "${className}". ${err.message}`
                            );
                            delete this._pendingScripts[className];

                            this.emit(`_scriptLoad_${className}`, false);

                            resolve();
                        }
                    }
                });
            }
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
                if (this[p] != undefined) {
                    data[p] = this[p];
                    meta[p] = this._meta[p];
                }
            });
        } else {
            if (this[propertyNames] != undefined) {
                data[propertyNames] = this[propertyNames];
                meta[propertyNames] = this._meta[propertyNames];
            }
        }

        this._notify(data, meta);
    }

    /**
     * Depreciated. Set visibility by setting control.visible to true/false.
     */
    Show() {
        this.visible = true;
    }

    /**
     * Depreciated. Set visibility by setting control.visible to true/false.
     */
    Hide() {
        this.visible = false;
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

    /**
     * Set the CSS visibility to visible. This does not change the control.visible property.
     */
    _show() {
        this._element.style.display = this.visibleDisplayCss;
    }

    /**
     * Set the CSS visibility to hidden. This does not change the control.visible property.
     */
    _hide() {
        this._element.style.display = this.hiddenDisplayCss;
    }

    // notifies parent of data change, and triggers onChange event.
    _notify(data, meta) {
        if (this._parent != undefined) {
            let n = {
                [this.name]: data,
            };

            if (!this.hideData) {
                this._parent._notify(n, meta);
            }
        }

        this.emit("data", data, undefined, meta);
    }

    // Generate a unique ID
    _generateUuid() {
        // code from https://stackoverflow.com/questions/105034/how-to-create-a-guid-uuid
        return (
            "_" +
            ([1e7] + -1e3 + -4e3 + -8e3 + -1e11)
                .replace(/[018]/g, (c) =>
                    (
                        c ^
                        (crypto.getRandomValues(new Uint8Array(1))[0] &
                            (15 >> (c / 4)))
                    ).toString(16)
                )
                .replace(/-/g, "")
        );
    }

    // Return an existing class from a passed string class name
    _getDynamicClass(name) {
        // adapted from https://stackoverflow.com/questions/5646279/get-object-class-from-string-name-in-javascript

        // Create global cache
        if (!window._cls_) {
            window._cls_ = {};
        }

        if (!window._cls_[name]) {
            // cache is not ready, fill it up
            if (name.match(/^[a-zA-Z0-9_]+$/)) {
                // proceed only if the name is a single word string
                try {
                    window._cls_[name] = eval(name);
                } catch {
                    return undefined;
                }
            } else {
                // arbitrary code is detected
                // throw new Error(`Class "${name}" does not exist`);
                return undefined;
            }
        }
        return window._cls_[name];
    }

    // Order all child controls according to this control's orderBy and orderAsc properties.
    _order() {
        if (this.orderBy) {
            // Subscribe to child controls orderBy properties
            this._sorted.forEach((control) => {
                // Unsubscribe from previous property changes
                if (control.__sortCallback) {
                    control.off(this._orderByPrev, control.__sortCallback);
                }

                // Subscribe to new order property changes
                control.__sortCallback = function () {
                    this._orderSingle(control);
                }.bind(this);
                control.on(this.orderBy, control.__sortCallback, {
                    caller: this,
                });
            });

            // Get sortable child controls
            let sortable = [];
            Object.values(this._controls)
                .filter(
                    (t) =>
                        (t._init &&
                            t[this.orderBy] != undefined &&
                            !t._parentElement) ||
                        t._parentElement == "_controlsDiv"
                )
                .forEach((c) => {
                    if (typeof c[this.orderBy] == "number") {
                        c._sortVal = c[this.orderBy];
                    } else {
                        c._sortVal = c[this.orderBy].toString().toLowerCase();
                    }
                    sortable.push(c);
                });

            // Sort
            if (this.orderAsc) {
                this._sorted = sortable.sort((a, b) => {
                    if (a._sortVal > b._sortVal) return 1;
                    if (b._sortVal > a._sortVal) return -1;
                    return 0;
                });
            } else {
                this._sorted = sortable.sort((b, a) => {
                    if (a._sortVal > b._sortVal) return 1;
                    if (b._sortVal > a._sortVal) return -1;
                    return 0;
                });
            }

            if (this._sorted.length >= 1) {
                // Move the last sorted element to the end of the div
                this["_controlsDiv"].appendChild(
                    this._sorted[this._sorted.length - 1]._element
                );
            }
            // Apply sort order to html elements
            for (let i = this._sorted.length - 2; i >= 0; i--) {
                let element = this._sorted[i]._element;
                let nextElement = this._sorted[i + 1]._element;
                this["_controlsDiv"].insertBefore(element, nextElement);
            }
        } else {
            this._sorted.forEach((control) => {
                // unsubscribe from child orderBy property changes
                if (control.__sortCallback) {
                    control.off(this._orderByPrev, control.__sortCallback);
                    delete control.__sortCallback;
                }
            });
            this._sorted = [];
        }

        this._orderByPrev = this.orderBy;
    }

    // Change a single child control's sort position based on the property value defined by the parent's orderBy value.
    _orderSingle(control) {
        if (typeof control[this.orderBy] == "number") {
            control._sortVal = control[this.orderBy];
        } else {
            control._sortVal = control[this.orderBy].toString().toLowerCase();
        }

        // Remove control from _sorted array
        let removeIndex = this._sorted.findIndex((t) => t.name == control.name);
        if (removeIndex >= 0) this._sorted.splice(removeIndex, 1);

        // Calculate index for inserting in _sorted array
        let insertIndex;
        if (this.orderAsc) {
            insertIndex = this._sorted.findIndex(
                (t) => t._sortVal > control._sortVal
            );
        } else {
            insertIndex = this._sorted.findIndex(
                (t) => t._sortVal < control._sortVal
            );
        }
        if (insertIndex < 0) insertIndex = this._sorted.length;

        // Insert into the _sorted array
        this._sorted.splice(insertIndex, 0, control);

        // Apply sort order to HTML element
        let element = control._element;
        if (insertIndex >= this._sorted.length - 1) {
            this["_controlsDiv"].appendChild(element);
        } else {
            let nextElement = this._sorted[insertIndex + 1]._element;
            this["_controlsDiv"].insertBefore(element, nextElement);
        }
    }

    /**
     * Set the filter function that should be applied to child controls' visibility. The filter() function does not change the control.visible property of child controls but merely hides / shows the HTML elements of the child controls based on the passed function output.
     * @param {function} filterFunction - Filter function (e.g. t => t.filterProperty == filterValue)
     * @param {object} options - Optional filter options: { monitor: ['propertyName1', 'propertyName2'] } - monitor: An array of child control property names which will trigger the filter on child property value(s) change.
     */
    filter(filterFunction, options) {
        if (typeof filterFunction == "function") {
            this._filterFunction = filterFunction;
            this._filter(filterFunction, options);
        } else if (filterFunction == undefined) {
            this._filterFunction = undefined;
            this._filter();
        } else {
            console.log("Filter function is not a valid function");
        }
    }

    /**
     * Apply visual filter
     * @param {function} filterFunction
     * @param {object} options - Optional filter options: { monitor: ['propertyName1', 'propertyName2'] } - monitor: An array of child control property names which will trigger the filter on child property value(s) change.
     */
    _filter(filterFunction, options) {
        if (options && options.monitor && Array.isArray(options.monitor)) {
            // Add new filter options
            options.monitor.forEach((propertyName) => {
                if (!this._filterMonitorProperties[propertyName]) {
                    this._filterMonitorProperties[propertyName] = true;

                    // Subscribe to property change event on all existing child controls
                    Object.values(this._controls).forEach((control) => {
                        control._filterCallbacks[propertyName] = control.on(
                            propertyName,
                            () => {
                                if (filterFunction && filterFunction(control)) {
                                    control._show();
                                } else {
                                    control._hide();
                                }
                            },
                            { caller: this }
                        );
                    });
                }
            });

            // Remove old filter options
            Object.keys(this._filterMonitorProperties).forEach(
                (propertyName) => {
                    if (!options.monitor.find((p) => p == propertyName)) {
                        delete this._filterMonitorProperties[propertyName];

                        // Unsubscribe from property change event on all child controls
                        Object.values(this._controls).forEach((control) => {
                            if (control._filterCallbacks[propertyName]) {
                                control.off(
                                    propertyName,
                                    control._filterCallbacks[propertyName]
                                );
                                delete control._filterCallbacks[propertyName];
                            }
                        });
                    }
                }
            );
        } else {
            this._filterMonitorProperties = {};

            // Unsubscribe from all property change events on all child controls if no property names to be monitored is passed.
            Object.values(this._controls).forEach((control) => {
                Object.keys(control._filterCallbacks).forEach(
                    (propertyName) => {
                        control.off(
                            propertyName,
                            control._filterCallbacks[propertyName]
                        );
                        delete control._filterCallbacks[propertyName];
                    }
                );
            });
        }

        if (filterFunction) {
            // Apply filter
            Object.values(this._controls).forEach((control) => {
                if (control.visible) {
                    if (filterFunction(control)) {
                        control._show();
                    } else {
                        control._hide();
                    }
                }
            });
        } else {
            // Remove filter
            Object.values(this._controls).forEach((control) => {
                if (control.visible) {
                    control._show();
                }
            });
        }
    }
}
/* #endregion */

/* #region  uiTopLevelContainer */
class uiTopLevelContainer extends ui {
    /**
     * Top level container is added to the passed DOM element. Use the SetData() function to add child controls to the top level element.
     * @param {string} path - path to the modular-ui controls directory. If not passed, assume that the modular-ui js files are in the root folder.
     * @param {string} element - ID of the HTML DOM element where the top level container should be inserted. If not passed, the top level container is added directly to the body element.
     */
    constructor(path, element) {
        super();

        if (path != undefined) {
            this._path = path;
        }

        if (element == undefined) {
            document.body.innerHTML += this.html;
        } else {
            this.name = "modular-ui top level container";
            let e = document.getElementById(element);
            if (e) {
                e.innerHTML += this.html;
            } else {
                console.log(`Unable to find element "${element}"`);
            }
        }

        this.Init();
        this._init = true;
    }
}
/* #endregion */

/* #region  multiple extendable classes */

/**
 * _uiClasses is a function added to modular-ui, to be able to extend a class with more that one class
 * !!! Important to note, that if both super classes contains the same porperty/ function (porperty/ function name, will be overwriten by the last class loaded containing that property/ function)
 * Link to referance used: https://stackoverflow.com/questions/29879267/es6-class-multiple-inheritance
 * @param {Object} baseClass - Base class to be extended with sub classes
 * @param  {...any} mixins - Classes to be added to the base class, (comma separated eg. uiClasses(BaseClass, ClassA, ClassB, ClassC))
 * @returns Base class
 */
function _uiClasses(baseClass, ...mixins) {
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
