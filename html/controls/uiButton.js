// =====================================
// button with value
// user control
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// Class declaration
// -------------------------------------

class uiButton extends _uiControl {
  constructor() {
    super();
    this.displayName = "click here";
    this._styles.push("controls/css/bootstrap.min.css");
  }

  // -------------------------------------
  // Getters & setters
  // -------------------------------------

  get html() {
    return `
        <!-- ${this.name} --> 
        <button class="btn btn-danger id="${this._uuid}_button">${this.displayName}</button> 
        `;
  }
}
