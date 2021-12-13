// =====================================
// Textbox with label and helptext
// user control
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// Class declaration
// -------------------------------------

class uiTextBox extends _uiControl {
    constructor() {
        super();
        this.value = 'TextBox Value';
        this.sources.push('_uiControl');
        this.styles.push('controls/css/bootstrap')
    }

    // -------------------------------------
    // Getters & setters
    // -------------------------------------

    get html() {
        return `
        <div class="row">
            <div class="col-lg-6">${this.displayName}</div>
            <div class="col-lg-6">
                <input type="text" id="??" name="??">
                    ${this.value}
                </input>
            </div>
        </div>
        `;
    }
}
