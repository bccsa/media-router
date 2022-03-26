// Code from https://labs.k.io/creating-a-simple-custom-event-system-in-javascript/
class DispatcherEvent {
  constructor(eventName) {
    this.eventName = eventName;
    this.callbacks = [];
  }

  registerCallback(callback) {
    this.callbacks.push(callback);
  }

  unregisterCallback(callback) {
    const index = this.callbacks.indexOf(callback);
    if (index > -1) {
      this.callbacks.splice(index, 1);
    }
  }

  fire(data) {
    const callbacks = this.callbacks.slice(0);
    callbacks.forEach((callback) => {
      callback(data);
    });
  }
}

// code from https://labs.k.io/creating-a-simple-custom-event-system-in-javascript/
class Dispatcher {
  constructor() {
    this.events = {};
  }

  dispatch(eventName, data) {
    const event = this.events[eventName];
    if (event) {
      event.fire(data);
    }
  }

  on(eventName, callback) {
    let event = this.events[eventName];
    if (!event) {
      event = new DispatcherEvent(eventName);
      this.events[eventName] = event;
    }
    event.registerCallback(callback);
  }

  off(eventName, callback) {
    const event = this.events[eventName];
    if (event && event.callbacks.indexOf(callback) > -1) {
      event.unregisterCallback(callback);
      if (event.callbacks.length === 0) {
        delete this.events[eventName];
      }
    }
  }
}

// =====================================
// Base class for ui controls
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// Class declaration
// -------------------------------------

class _uiControl extends Dispatcher {
  constructor() {
    super();
    this.name = "controlName"; // Special property indicating the name of the control. This cannot be changed in runtime, but should be set in the data received when creating new child controls.
    this.controlType = this.constructor.name; // The name of the class. This property should not be set in code.
    this._parent = undefined; // Reference to the parent control (if any)
    this._head = undefined; // Header DOM object reference (only used by top level parent control)
    this._controls = {}; // List of child controls
    this._initQueue = []; // Queue child controls to be initialized while this control is not yet initialized
    this._styles = []; // Add css style paths to this array
    this._appliedStyles = []; // List of applied CSS style sheets
    this._uuid = this._generateUuid(); // Unique ID for this control
    this._controlsDiv = undefined; // Add a DOM reference to the _controlsDiv property if the control must support child controls
    this._init = false; // True when the control has been initilized (DOM linkup complete)
    this._UpdateList = []; // List of properties that needs to be updated
    this.parentElement = undefined; // Used to specify in which HTML element in the parent the child should be added
    this.hideData = false; // Set to true if the control's data should be excluded from GetData() and from _notify();
  }

  // -------------------------------------
  // Override Getters & setters
  // -------------------------------------

  // Override this getter in the implementing class
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

  // Implementing class should override this function
  // This function is called by the parent control when the child's (this control) html has been printed to the DOM.
  Init() {
    this._mainDiv = document.getElementById(`${this._uuid}_main`);

    // Element containing child controls. Controls that should not be able to host child controls
    // should not include this line.
    this._controlsDiv = document.getElementById(`${this._uuid}_controls`);
  }

  // Implementing class should override this function if needed
  // This function is called by the parent control when the child's (this control) html should be removed from the DOM.
  RemoveHtml() {
    this._mainDiv.remove();
  }

  // Implementing class should override this function
  // This function is called when data has been received through the SetData method.
  Update(propertyName) {}

  // -------------------------------------
  // Core functions
  // -------------------------------------

  // Set data in JSON
  SetData(data) {
    Object.keys(data).forEach((k) => {
      // Ignore invalid and special keys
      if (k[0] != "_" && k != "controlType") {
        // Update this control's settable (not starting with "_") properties
        if (
          this[k] != undefined &&
          (typeof this[k] == "number" ||
            typeof this[k] == "string" ||
            typeof this[k] == "boolean")
        ) {
          this[k] = data[k];

          // Notify to update the DOM if control has been initialized
          if (this._init) {
            this._UpdateList.push(k);
          }
        }
        // Update child controls. If a child control shares the name of a settable property, the child control will not receive data.
        else if (this._controls[k] != undefined) {
          this._controls[k].SetData(data[k]);
        }
        // Create a new child control if the passed data has controlType set. If this control is not ready yet (Init did not run yet),
        // add new child controls to a controls queue.
        else if (data[k].controlType != undefined) {
          let c = this._getDynamicClass(data[k].controlType);
          if (c != undefined) {
            // Create new control
            let newControl = new c();
            newControl.SetData(data[k]);
            newControl._parent = this;

            // Add new control to controls list
            this._controls[newControl.name] = newControl;

            // Determine destination element
            let e = "_controlsDiv"; // default div
            if (data[k].parentElement != undefined) {
              e = data[k].parentElement;
            }

            // Initialize child controls, or add to initialization queue if this control is not initialized yet
            if (!this._init) {
              this._initQueue.push({ control: newControl, element: e });
            } else {
              this._initControl(newControl, e);
            }
          }
        }
      }
    });

    // Update the DOM
    this._UpdateList.forEach((k) => {
      this.Update(k);
    });
  }

  // Initialize a child control and print it in the passed element name (String)
  _initControl(control, element) {
    let e = this[element];
    if (control != undefined && control.name != undefined && e != undefined) {
      // Wait for HTML to be printed _controlsDiv element, and call Init
      const observer = new MutationObserver(function (mutationsList, observer) {
        control._styles.forEach((s) => {
          control._parent.ApplyStyle(s);
        });

        control.Init();
        observer.disconnect();
        control._init = true;
        // Notify that initialization is done
        control.dispatch("init", control);

        // ################## test logic #######################
        console.log(`Control ${control.name} added to the DOM`);

        // Add queued child controls
        while (control._initQueue.length > 0) {
          let c = control._initQueue.shift();
          control._initControl(c.control, c.element);
        }
      });

      // Observe controls element for changes to contents
      observer.observe(e, { childList: true });

      // Print HTML of child control to the controls element
      e.innerHTML += control.html;
    } else {
      throw new Error(
        "Unable to add child control. Child control is either invalid, or this control does not have a _controlsDiv DOM element."
      );
    }
  }

  // Get data in JSON
  GetData() {
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
    Object.keys(this._controls).forEach((k) => {
      if (
        this._controls[k].GetData() != undefined &&
        !this._controls[k].hideData
      ) {
        data[k] = this._controls[k].GetData();
      }
    });

    return data;
  }

  // Remove child control with associated data at the passed JSON path(s)
  Remove(path) {
    Object.keys(path).forEach((k) => {
      if (this._controls[k] != undefined) {
        // Check if the passed path has no children
        if (Object.keys(path[k]).length == 0) {
          this._controls[k].RemoveHtml();
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
    if (!this._appliedStyles.includes(ref)) {
      this._appliedStyles.push(ref);
      if (this._parent != undefined) {
        this._parent.ApplyStyle(ref);
      } else {
        if (this._head == undefined) {
          this._head = document.getElementsByTagName(`head`)[0];
        }

        this._head.innerHTML += `<link rel="stylesheet" href="${ref}">`;
      }
    }
  }

  // notifies parent of a change to the given property or array of properties, and triggers the onChange event.
  _notifyProperty(propertyNames) {
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

  // notifies parent of data change, and triggers onChange event.
  _notify(data) {
    if (this._parent != undefined) {
      let n = {
        [this.name]: data,
      };

      if (!this.hideData) {
        this._parent._notify(n);
      }
    }

    this.dispatch("data", data);
  }

  // Generate a unique ID for this control
  _generateUuid() {
    // code from https://stackoverflow.com/questions/105034/how-to-create-a-guid-uuid
    return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c) =>
      (
        c ^
        (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))
      ).toString(16)
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

  // _getDynamicClass(name) {
  //     // adapted from https://stackoverflow.com/questions/5646279/get-object-class-from-string-name-in-javascript

  //     // Create global cache
  //     if(!window._cls) {
  //         window._cls = {};
  //     }

  //     if(!window._cls[name]) {
  //         // cache is  not ready yet, fill it up
  //         if(name.match(/^[a-zA-Z0-9_]+$/)) {
  //             // proceed only  if the  name is a single word string
  //             window._cls_[name] = eval(name);
  //         } else {
  //             // arbitrary code is detected
  //             throw new  Error(`Class "${name}" does not exist`);
  //         }
  //     }
  //     return window._cls_[name];
  // }
}
