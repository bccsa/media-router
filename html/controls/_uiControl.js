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
        this.name = "controlName";
        this.displayName = "new control";   // Display name
        this.helpText = "new control help text";
        this.type = this.constructor.name;  // The name of the class. This property should not be set in code.
        this.parent = undefined;            // Reference to the parent control (if any)
        this._head = undefined;            // Header DOM object reference (only used by top level parent control)
        this.controls = [];                 // Array of child controls
        // this._sources = [];                 // Add javascript source paths to this array
        this.styles = [];                  // Add css style paths to this array
        this._uuid = this._generateUuid();

        // Initialize control
        // document.addEventListener('readystatechange', this._init(this));
        this._abortController = new AbortController();
        document.addEventListener('DOMContentLoaded', this._init(this), { signal: _abortController.signal } );
        // window.addEventListener('load', this._init(this), { signal: this._abortController.signal } );
        // document.addEventListener('readystatechange', this._init(this), { signal: this._abortController.signal });
    }

    // Control initialization
    _init(control) {
        // if (document.readyState === 'complete') {
            //document.removeEventListener('readystatechange',  control._init(control));
            this._abortController.abort();
            control.DomLinkup();
        // }
        // else {
            //control._abortController.abort();
        //     document.addEventListener('readystatechange', control._init(control), { signal: control._abortController.signal });
        // }
    }

    // -------------------------------------
    // Getters & setters
    // -------------------------------------

    // Override this getter in the implementing class
    get html() {
        return `
        <div id="${this._uuid}_main">
            <h1>Example html code</h1>
            <span>${this.displayName}</span>
            <p>${this.helpText}</p>
            <div id="${this._uuid}_controls">
                ${this._getControlsHtml()}
            </div>
        </div>
        `;
    }

    // // Get a list of javascript source paths for this control including any child controls
    // get sources() {
    //     let s = [...this._sources];
    //     this.controls.forEach(control => {
    //         s.concat(control.sources);
    //     });
    //     return [...new Set(s)];
    // }

    // get sourcesHtml() {
    //     let h = '';
    //     this.sources.forEach(s => {
    //         h += `<script src="${s}"></script>`
    //     }); 
    //     return h;
    // }

    // Get a list of css file source paths for this control including any child controls
    // get styles() {
    //     let s = [...this._styles];
    //     this.controls.forEach(control => {
    //         s.concat(control.styles);
    //     });
    //     return [...new Set(s)];
    // }

    // get stylesHtml() {
    //     let h = '';
    //     this.styles.forEach(s => {
    //         h += `<link rel="stylesheet" href="${s}">`
    //     });
    //     return h;
    // }

    // -------------------------------------
    // functions
    // -------------------------------------

    // Implementing class should override this function
    // This function is called by the parent control when the child's (this control) html has been printed to the DOM.
    DomLinkup() {
        this._mainDiv = document.getElementById(`${this._uuid}_main`);
        this._mainDiv.addEventListener("click", e => {
            // Do something
        });

        // Element containing child controls. Controls that should not be able to host child controls
        // should not include this line.
        this._controlsDiv = document.getElementById(`${this._uuid}_controls`);
    }

    // Add a child control to this control
    AddControl(control) {
        // Add child control to child controls list
        this.controls.push(control);

        // Set the parent of the child control to this control
        control.parent = this;

        // Print the HTML of the child control inside this control, and linkup child to the DOM.
        if (this._controlsDiv != undefined) {
            this._controlsDiv.innerHTML += control.html;
            control.DomLinkup();
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
        return c;
    }
    

    // Apply a new stylesheet (css) file
    ApplyStyle(ref) {
        if (!this._styles.includes(ref))
        {
            this._styles.push(ref);
            if (this.parent != undefined) {
                this.parent.ApplyStyle(ref);
            }
            else {
                if (this._head == undefined) {
                    this._head = document.getElementsByTagName(`head`)[0];
                }

                this._head.innerHTML += `<link rel="stylesheet" href="${ref}">`;
            }
        }
    }

    _getControlsHtml() {
        let h = ``;
        this.controls.forEach(control => {
            if (control.html != undefined) {
                h += control.html;
            }
        });

        return h;
    }

    _generateUuid() {
        // code from https://stackoverflow.com/questions/105034/how-to-create-a-guid-uuid
        return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
            (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
        );
    }

    
}

// Export class
module.exports._uiControl = _uiControl;

