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
    this.value = "TextBox Value";
    this.styles.push("controls/css/bootstrap.min.css");
  }

  // -------------------------------------
  // Getters & setters
  // -------------------------------------

  get html() {
    return `
        <!-- ${this.name} --> 
            <div id="${this._uuid}_main" class="col-lg-3">
                <div> 
                    <label>${this.displayName}</label>
                    <input type="text" id="${this._uuid}_input" class="form-control" value="${this.value}">
                </div>
                <div id="${this._uuid}_controls">
                    ${this._getControlsHtml()}
                </div> 
            </div> 
        `;
  }

  DomLinkup() {
    this._mainDiv = document.getElementById(`${this._uuid}_main`);

    // Element containing child controls
    this._input = document.getElementById(`${this._uuid}_input`);

    // This should be defined if the super AddControl function should be able to add child controls to this control
    this._controlsDiv = document.getElementById(`${this._uuid}_controls`);
  }
}
