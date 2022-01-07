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
    this.displayName = "new control";   // Display name
    this.helpText = "new control help text";
    this.value = "TextBox Value";
    this._styles.push("controls/css/bootstrap.min.css");
  }

  // -------------------------------------
  // Getters & setters
  // -------------------------------------

  get html() {
    return `
        <!-- ${this.name} --> 
        <div id="${this._uuid}_main" class="col-lg-3">
            <div> 
                <label id="${this._uuid}_label">${this.displayName}</label>
                <input type="text" id="${this._uuid}_input" class="form-control" value="${this.value}">
            </div>
            <div id="${this._uuid}_controls"></div> 
        </div> 
        `;
  }

  DomLinkup() {
    this._mainDiv = document.getElementById(`${this._uuid}_main`);
    this._input = document.getElementById(`${this._uuid}_input`);
    this._label = document.getElementById(`${this._uuid}_label`);

    this._controlsDiv = document.getElementById(`${this._uuid}_controls`);
  }

  DomUpdate(propertyName) {
    switch (propertyName) {
      case "value": {
        this._input.value = this.value;
        break;
      }
      case "displayName": {
        this._label.innerText = this.displayName;
        break;
      }
    }
  }
}

