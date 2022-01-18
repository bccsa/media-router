// =====================================
// button with value
// user control
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// Class declaration
// -------------------------------------

class uiSwitchButton extends _uiControl {
  constructor() {
    super();
    this.displayName = "";
    this.helpText = "How to use this button";
    // this.styles.push("controls/css/switch.css");
    // this.styles.push("controls/css/bootstrap.min.css");
  }

  // -------------------------------------
  // Getters & setters
  // -------------------------------------

  get html() {
    return `
      <!-- ${this.name} -->
      <label class="switch" 
      data-toggle="tooltip"
      data-placement="rigth"
      title="${this.helpText}"
      id="${this._uuid}_switch" >
       
      <input type="checkbox">
      <span class="slider round"></span>
    </label>
          `;
  }

  DomLinkup() {
    this._switch = document.getElementById(`${this._uuid}_switch`);
    this._helpText = document.getElementById(`${this._uuid}_help`);

    // console.log(this._switch);

    let o = this;

    this._switch.addEventListener("change", function () {
      o.value = o._switch.value;
      o._notifyProperty(["value"]);
    });
  }

  DomUpdate(propertyName) {
    switch (propertyName) {
      case "value": {
        this._switch.value = this.value;
        break;
      }

      case "displayName": {
        this._label.innerText = this.displayName;
        break;
      }
    }
  }
}
