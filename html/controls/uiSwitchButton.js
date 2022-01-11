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
    this.styles.push("controls/css/switch.css");
    this.styles.push("controls/css/bootstrap.min.css");
  }

  // -------------------------------------
  // Getters & setters
  // -------------------------------------

  get html() {
    return `
      <!-- ${this.name} -->
        <div class="switch">
            <input type="checkbox" id="${this._uuid}_switch>
            <span class="slider round"></span>
        </div>  
          `;
  }
}
