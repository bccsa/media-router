// =====================================
// Simple Container
// user control
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// Class declaration
// -------------------------------------

class uiSimpleContainer extends _uiControl {
  constructor() {
    super();
  }

  // -------------------------------------
  // Getters & setters
  // -------------------------------------

  get html() {
    return `
      <div id="${this._uuid}_main">
        <!-- ${this.name} -->  
        <div class="" id="${this._uuid}_controls">
        </div>
      </div>`;
  }

  Init() {
    this._mainDiv = document.getElementById(`${this._uuid}_main`);
    this._controlsDiv = document.getElementById(`${this._uuid}_controls`);
  }
}
