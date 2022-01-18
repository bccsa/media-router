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
    this.displayName = "new control";         // Display name
    this.helpText = "new control help text";
    this.value = "TextBox Value";
    this.labelWidth = "400px";               // Label width in px
    this.margin = "10px"
    this._styles.push("controls/css/bootstrap.min.css");
  }

  // -------------------------------------
  // Getters & setters
  // -------------------------------------

  get html() {
    return `
        <!-- ${this.name} --> 
        <div id="${this._uuid}_main" class="col-lg-12" style="margin: ${this.margin}">
            <div class="d-flex"> 
                <label id="${this._uuid}_label" style="width: ${this.labelWidth}">${this.displayName}</label>
                <input type="text" id="${this._uuid}_input" class="form-control" value="${this.value}">
            </div>
        </div> 
        `;
  }

  DomLinkup() {
    this._mainDiv = document.getElementById(`${this._uuid}_main`);
    this._input = document.getElementById(`${this._uuid}_input`);
    this._label = document.getElementById(`${this._uuid}_label`);

    let o = this;
    this._input.addEventListener('change', function(){
      o.value = o._input.value;
      o._notifyProperty(['value']);
    });
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
      case "labelWidth": {
        this._label.style.width = this.labelWidth;
        break;
      }
      case "margin": {
        this._label.style.margin = this.margin;
        break;
      }
    }
  }
}

