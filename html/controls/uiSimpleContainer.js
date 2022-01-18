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
        <!-- ${this.name} --> 
        <div id="${this._uuid}_controls">
                  
        </div>`;
  }

  DomLinkup() {
    this._controlsDiv = document.getElementById(`${this._uuid}_controls`);
  }
}

