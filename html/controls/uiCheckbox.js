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
  
      this.styles.push("controls/css/bootstrap.min.css");
    }
  
    // -------------------------------------
    // Getters & setters
    // -------------------------------------
  
    get html() {
      return `
            <!-- ${this.name} -->
          <label class="switch">
              <input type="checkbox" id="${this._uuid}_switch>
              <span class="slider round"></span>
          </label>  
            `;
    }
  }
  