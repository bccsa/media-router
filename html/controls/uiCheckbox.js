// =====================================
// button with value
// user control
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// Class declaration
// -------------------------------------

class uiCheckbox extends _uiControl {
  constructor() {
    super();
    this.displayName = "click here";
    this.helpText = "How to use this checkBox";
    this.value = false;
    this._styles.push("controls/css/bootstrap.min.css");
    this._styles.push("controls/css/uiCheckbox.css");
  }

  // -------------------------------------
  // Getters & setters
  // -------------------------------------

  get html() {
    return `
            <!-- ${this.name} --> 
            <div id="${this._uuid}_main"
              class="col-lg-3 uiCheckbox"
              data-toggle="tooltip"
              data-placement="rigth"
              title="${this.helpText}">
              <label id="${this._uuid}_label">${this.displayName}</label>
              <input type="checkbox"  
                id="${this._uuid}_checkBox" 
                name="${this.displayName}">
            </div> 
            `;
  }

  Init() {
    this._mainDiv = document.getElementById(`${this._uuid}_main`);
    this._checkbox = document.getElementById(`${this._uuid}_checkBox`);
    this._helpText = document.getElementById(`${this._uuid}_help`);
    this._label = document.getElementById(`${this._uuid}_label`);

    // Set initial value
    this._checkbox.checked = this.value;

    // Event handling
    let o = this;
    this._checkbox.addEventListener("change", function () {
      o.value = o._checkbox.checked;
      o._notifyProperty("value");
    });
  }

  Update(propertyName) {
    switch (propertyName) {
      case "helpText": {
        this._checkbox.title = this.helpText;
        break;
      }
      case "value": {
        this._checkbox.checked = this.value;
        break;
      }
      case "displayName": {
        this._label.innerHTML = this.displayName;
        break;
      }
    }
  }
}
