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
        this.controls = [];                 // Array of child controls
        this._sources = [];                 // Add javascript source paths to this array
        this._styles = [];                  // Add css style paths to this array
        this._uuid = this._generateUuid();
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

    // Get a list of javascript source paths for this control including any child controls
    get sources() {
        let s = [...this._sources];
        this.controls.forEach(control => {
            s.concat(control.sources);
        });
        return [...new Set(s)];
    }

    get sourcesHtml() {
        let h = '';
        this.sources.forEach(s => {
            h += `<script src="${s}"></script>`
        });
        return h;
    }

    // Get a list of css file source paths for this control including any child controls
    get styles() {
        let s = [...this._styles];
        this.controls.forEach(control => {
            s.concat(control.styles);
        });
        return [...new Set(s)];
    }

    get stylesHtml() {
        let h = '';
        this.styles.forEach(s => {
            h += `<link rel="stylesheet" href="${s}">`
        });
        return h;
    }

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

        // Element containing child controls
        this._controlsDiv = document.getElementById(`${this._uuid}_controls`);
    }

    // Add a child control to this control
    AddControl(control) {
        this.controls.push(control);
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

