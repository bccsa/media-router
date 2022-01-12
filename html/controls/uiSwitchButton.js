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
    this.displayName = "switch here";
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

    // let o = this;

    console.log("switch", this._switch);

    this._switch.addEventListener("change", function () {
      console.log("switchOn");
    });
  }
}
