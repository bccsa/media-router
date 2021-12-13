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
        this._sources.push('controls/js/ThisDoesNotExist.js');
        this._styles.push('controls/css/bootstrap.min.css')
    }

    // -------------------------------------
    // Getters & setters
    // -------------------------------------

    get html() {
        return `
        <!-- ${this.name} -->
        <div id="${this._uuid}_main" class="row">
            <div class="col-lg-6">${this.displayName}</div>
            <div class="col-lg-6">
                <input type="text" id="${this._uuid}_input" value="${this.value}">
                <div id="${this._uuid}_controls">
                    ${this._getControlsHtml()}
                </div>
            </div>
        </div>
        `;
    }

    DomLinkup() {
        this._mainDiv = document.getElementById(`${this._uuid}_main`);
        // this._mainDiv.addEventListener("click", e => {
        //     // Do something
        // });

        // Element containing child controls
        this._input = document.getElementById(`${this._uuid}_input`);

        // This should be defined if the super AddControl function should be able to add child controls to this control
        this._controlsDiv = document.getElementById(`${this._uuid}_controls`);
    }
}
