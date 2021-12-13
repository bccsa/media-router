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

        this.displayName = "new control";   // Display name
        this.helpText = "new control help text";
        this.type = this.constructor.name;  // The name of the class. This property should not be set in code.
        this.controls = [];                 // Array of child controls
        this._sources = [];                 // Override / add javascript source paths to this array
        this._styles = [                    // Add css style paths to this array
            'controls/css/bootstrap.min.css'
        ]; 
    }

    // -------------------------------------
    // Getters & setters
    // -------------------------------------

    // Override this getter in the implementing class
    get html() {
        return `
        <div>
            <h1>Example html code</h1>
            <span>${this.displayName}</span>
            <p>${this.helpText}</p>
            <div>
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

    // Get a list of css file source paths for this control including any child controls
    get styles() {
        let s = [...this._styles];
        this.controls.forEach(control => {
            s.concat(control.styles);
        });
        return [...new Set(s)];
    }

    // -------------------------------------
    // functions
    // -------------------------------------

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
}

// Export class
module.exports._uiControl = _uiControl;

