// ======================================
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
    }

    // -------------------------------------
    // Getters & setters
    // -------------------------------------
    // Override this getter in the implementing class
    get html() {
        let h = ``;
        this.controls.forEach(control => {
            if (control.html != undefined) {
                h += control.html;
            }
        });
        return `
        <div>
            <span>${this.displayName}</span>
            <p>${this.helpText}</p>
            <div>
                ${h}
            </div>
        </div>
        `
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
}

// Export class
module.exports._uiControl = _uiControl;