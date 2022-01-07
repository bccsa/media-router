// =====================================
// Base class for ui controls
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// Class declaration
// -------------------------------------

class _uiControl {
    constructor() {
        this.name = "controlName";          // Special property indicating the name of the control. This cannot be changed in runtime, but should be set in the data received when creating new child controls.
        this.controlType = this.constructor.name;  // The name of the class. This property should not be set in code.
        this._parent = undefined;           // Reference to the parent control (if any)
        this._head = undefined;             // Header DOM object reference (only used by top level parent control)
        this._controls = {};                // List of child controls
        this._controlQueue = [];            // Queue child controls to be added to this control while this control is not yet initialized
        this._styles = [];                  // Add css style paths to this array
        this._appliedStyles = [];           // List of applied CSS style sheets
        this._uuid = this._generateUuid();  // Unique ID for this control
        this._controlsDiv = undefined;      // Add a DOM reference to the _controlsDiv property if the control must support child controls
        this._init = false;                 // True when the control has been initilized (DOM linkup complete)
        this._domUpdateList = [];           // List of properties that needs to be updated;

    }

    // -------------------------------------
    // Override Getters & setters
    // -------------------------------------

    // Override this getter in the implementing class
    get html() {
        return `
        <!-- ${this.name} -->
        <div id="${this._uuid}_main">
            <div id="${this._uuid}_controls"></div>
        </div>
        `;
    }

    // -------------------------------------
    // Override Functions
    // -------------------------------------

    // Implementing class should override this function
    // This function is called by the parent control when the child's (this control) html has been printed to the DOM.
    DomLinkup() {
        this._mainDiv = document.getElementById(`${this._uuid}_main`);

        // Element containing child controls. Controls that should not be able to host child controls
        // should not include this line.
        this._controlsDiv = document.getElementById(`${this._uuid}_controls`);
    }

    // Implementing class should override this function if needed
    // This function is called by the parent control when the child's (this control) html should be removed from the DOM.
    DomRemove() {
        this._mainDiv.remove();
    }

    // Implementing class should override this function
    // This function is called when data has been received through the SetData method.    
    DomUpdate(propertyName) {

    }

    // -------------------------------------
    // Core functions
    // -------------------------------------

    // Add a child control to this control
    AddControl(control) {
        if (control != undefined && control.name != undefined && this._controlsDiv != undefined) {
            // Add child control to controls list
            this._controls[control.name] = control;

            // Set the parent of the child control to this control
            control._parent = this;

            // Wait for HTML to be printed _controlsDiv element, and call DomLinkup
            const observer = new MutationObserver(function(mutationsList, observer){
                control._styles.forEach(s => {
                    control._parent.ApplyStyle(s);
                })
                
                control.DomLinkup();
                observer.disconnect();
                control._init = true;

                console.log(control.name);

                // Add queued child controls
                while (control._controlQueue.length > 0) {
                    control.AddControl(control._controlQueue.shift());
                }
            });
    
            // Observe _controlsDiv for changes to contents
            observer.observe(this._controlsDiv, { childList: true });

            // Print HTML of child control to _controlsDiv
            this._controlsDiv.innerHTML += control.html;
        }
        else {
            throw new Error('Unable to add child control. Child control is either invalid, or it does not have a _controlsDiv DOM element.');
        }
    }

    // Set data in JSON
    SetData(data) {
        Object.keys(data).forEach(k => {
            // Ignore invalid and special keys
            if (k[0] != '_' && k != "controlType") {
                // Update this control's settable (not starting with "_") properties
                if (this[k] != undefined && (typeof this[k] == 'number' || typeof this[k] == 'string' || typeof this[k] == 'boolean')) {
                    this[k] = data[k];

                    // Notify to update the DOM if control has been initialized
                    if (this._init) {
                        this._domUpdateList.push(k);
                    }
                }
                // Update child controls. If a child control shares the name of a settable property, the child control will not receive data.
                else if (this._controls[k] != undefined) {
                    this._controls[k].SetData(data[k]);
                }
                // Create a new child control if the passed data has controlType set. If this control is not ready yet (DomLinkup did not run yet),
                // add new child controls to a controls queue.
                else if (data[k].controlType != undefined)
                {
                    let c = this._getDynamicClass(data[k].controlType);
                    if (c != undefined) { 
                        let newControl = new c;
                        newControl.SetData(data[k]);
                        if (!this._init) {
                            this._controlQueue.push(newControl);
                        }
                        else {
                            this.AddControl(newControl);
                        }
                    }
                }
            }
        });

        // Update the DOM
        this._domUpdateList.forEach(k => {
            this.DomUpdate(k);
        })
    }

    // Get data in JSON
    GetData() {
        let data = {};

        // Get own properties
        Object.getOwnPropertyNames(this).forEach(k => {
            // Only return settable (not starting with "_") properties
            if (k[0] != '_' && (typeof this[k] == 'number' || typeof this[k] == 'string' || typeof this[k] == 'boolean')) {
                data[k] = this[k];
            }
        });

        // Get child controls properties
        Object.keys(this._controls).forEach(k => {
            if (this._controls[k].GetData() != undefined) {
                data[k] = this._controls[k].GetData();
            }
        });

        return data;
    }
    
    // Remove child control with associated data at the passed JSON path(s)
    Remove(path) {
        Object.keys(path).forEach(k => {
            if (this._controls[k] != undefined) {
                // Check if the passed path has no children
                if (Object.keys(path[k]).length == 0) {
                    this._controls[k].DomRemove();
                    delete this._controls[k];
                }
                // Pass the path to the child control
                else {
                    this._controls[k].Remove(path[k]);
                }
            }
        });
    }

    // Apply a new stylesheet (css) file
    ApplyStyle(ref) {
        if (!this._appliedStyles.includes(ref))
        {
            this._appliedStyles.push(ref);
            if (this._parent != undefined) {
                this._parent.ApplyStyle(ref);
            }
            else {
                if (this._head == undefined) {
                    this._head = document.getElementsByTagName(`head`)[0];
                }

                this._head.innerHTML += `<link rel="stylesheet" href="${ref}">`;
            }
        }
    }

    // Generate a unique ID for this control
    _generateUuid() {
        // code from https://stackoverflow.com/questions/105034/how-to-create-a-guid-uuid
        return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
            (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
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
              window._cls_[name] = eval(name);
            } else {
              // arbitrary code is detected 
              throw new Error(`Class "${name}" does not exist`);
            }
          }
          return window._cls_[name];
    }
}